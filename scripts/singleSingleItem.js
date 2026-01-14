// scripts/syncSingleItem.js
import axios from "axios";
import mongoose from "mongoose";
import InventoryItem from "../models/InventoryItem.js";
import { netsuiteConfig, generateOAuthHeaders } from "../config/netsuite.js";
import { connectDB } from "../config/db.js";

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
  maxRetries: 3,
  baseDelay: 2000, // 2 seconds base delay
  maxDelay: 10000, // 10 seconds max delay
  batchSize: 2, // Reduced batch size for 429 errors
  delayBetweenBatches: 3000, // 3 seconds between batches
  delayBetweenRequests: 1000, // 1 second between individual requests
};

// Helper function to extract value from NetSuite response
const extractValue = (data, fieldPath) => {
  const fields = fieldPath.split('.');
  let value = data;
  
  for (const field of fields) {
    if (value && typeof value === 'object' && field in value) {
      value = value[field];
    } else {
      return '';
    }
  }
  
  if (value && typeof value === 'object' && 'refName' in value) {
    return value.refName || '';
  }
  
  return value || '';
};

// Helper function to extract numeric value
const extractNumericValue = (data, fieldName) => {
  if (data && fieldName in data) {
    const value = data[fieldName];
    
    if (value === null || value === undefined) return 0.0;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? 0.0 : parsed;
    }
    
    return 0.0;
  }
  
  return 0.0;
};

// Helper function with retry logic
async function makeRequestWithRetry(url, method = "GET", retryCount = 0) {
  try {
    const headers = {
      'Authorization': generateOAuthHeaders(url, method),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    const response = await axios({
      method,
      url,
      headers,
      timeout: 30000
    });
    
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 429 && retryCount < RATE_LIMIT_CONFIG.maxRetries) {
      // Calculate exponential backoff with jitter
      const delay = Math.min(
        RATE_LIMIT_CONFIG.baseDelay * Math.pow(2, retryCount) + Math.random() * 1000,
        RATE_LIMIT_CONFIG.maxDelay
      );
      
      console.log(`⚠️ Rate limited (429). Retrying in ${Math.round(delay/1000)}s... (Attempt ${retryCount + 1}/${RATE_LIMIT_CONFIG.maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      return makeRequestWithRetry(url, method, retryCount + 1);
    }
    
    throw error;
  }
}

// Helper function to fetch price detail with retry
async function fetchPriceDetail(priceDetailUrl) {
  try {
    return await makeRequestWithRetry(priceDetailUrl, "GET");
  } catch (error) {
    console.error(`Error fetching price detail:`, error.message);
    return null;
  }
}

// Helper function to fetch price information
async function fetchPriceInformation(itemId, priceUrl) {
  try {
    console.log(`Fetching price information for item ${itemId}...`);
    
    const priceResponse = await makeRequestWithRetry(priceUrl, "GET");
    
    if (!priceResponse.items || priceResponse.items.length === 0) {
      console.log(`No price entries found for item ${itemId}`);
      return { 
        price: 0, 
        currency: "HKD",
        tradePrice: 0,
        retailPrice: 0
      };
    }
    
    console.log(`Found ${priceResponse.items.length} price entries`);
    
    let price = 0;
    let currency = "HKD";
    let tradePrice = 0;
    let retailPrice = 0;
    
    // Process each price entry with delay between them
    for (let i = 0; i < priceResponse.items.length; i++) {
      const priceItem = priceResponse.items[i];
      
      if (priceItem.links && priceItem.links[0] && priceItem.links[0].href) {
        const priceDetail = await fetchPriceDetail(priceItem.links[0].href);
        
        if (priceDetail) {
          const priceLevelName = priceDetail.priceLevelName || 'Unknown';
          const itemPrice = priceDetail.price || 0;
          
          console.log(`   ${priceLevelName}: ${itemPrice}`);
          
          // Check for WPL (Base) - trade price
          if (priceLevelName === "WLP (Base)") {
            tradePrice = itemPrice;
            console.log(`   ✅ Identified as trade price`);
          }
          // Check for LPCP (HKD) - retail price
          else if (priceLevelName === "LPCP (HKD)") {
            retailPrice = itemPrice;
            price = retailPrice;
            currency = "HKD";
            console.log(`   ✅ Identified as retail price`);
          }
        }
      }
      
      // Add delay between price detail fetches
      if (i < priceResponse.items.length - 1) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_CONFIG.delayBetweenRequests));
      }
    }
    
    // Set default price if retail price not found but trade price is
    if (retailPrice === 0 && tradePrice > 0) {
      price = tradePrice;
    }
    
    return { 
      price, 
      currency,
      tradePrice,
      retailPrice
    };
    
  } catch (error) {
    console.error(`Error fetching price information:`, error.message);
    return { 
      price: 0, 
      currency: "HKD",
      tradePrice: 0,
      retailPrice: 0
    };
  }
}

// Function to fetch location details with retry
async function fetchLocationDetails(itemId, locationUrl) {
  try {
    const locationData = await makeRequestWithRetry(locationUrl, "GET");
    
    // Now fetch the location's main address
    if (locationData.location && locationData.location.links && locationData.location.links[0]) {
      const locationId = locationData.location.id;
      const addressUrl = `${netsuiteConfig.baseUrl.replace('/record/v1', '')}/record/v1/location/${locationId}/mainAddress`;
      
      try {
        // Add delay before fetching address
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_CONFIG.delayBetweenRequests));
        
        const addressData = await makeRequestWithRetry(addressUrl, "GET");
        
        return {
          locationId: locationData.locationId?.toString() || locationId,
          location: locationData.location_display || locationData.location.refName || '',
          address: addressData.addressee || '',
          city: addressData.city || '',
          country: addressData.country?.refName || addressData.country || '',
          zip: addressData.zip || '',
          quantityOnHand: locationData.quantityOnHand || 0,
          quantityAvailable: locationData.quantityAvailable || 0
        };
      } catch (addressError) {
        if (addressError.response && addressError.response.status === 429) {
          console.error(`⚠️ Rate limited while fetching address for location ${locationId}. Skipping address...`);
        } else {
          console.error(`Error fetching address for location ${locationId}:`, addressError.message);
        }
      }
    }
    
    // Return basic data if address fetch fails
    return {
      locationId: locationData.locationId?.toString() || locationData.location?.id || '',
      location: locationData.location_display || locationData.location?.refName || '',
      address: '',
      city: '',
      country: '',
      zip: '',
      quantityOnHand: locationData.quantityOnHand || 0,
      quantityAvailable: locationData.quantityAvailable || 0
    };
  } catch (error) {
    if (error.response && error.response.status === 429) {
      console.error(`⚠️ Rate limited while fetching location from ${locationUrl}. Skipping this location...`);
    } else {
      console.error(`Error fetching location from ${locationUrl}:`, error.message);
    }
    return null;
  }
}

// Function to fetch all locations for an item with better rate limiting
async function fetchItemLocations(itemId, locationsUrl) {
  try {
    console.log(`Fetching locations list for item ${itemId}...`);
    
    const locationsResponse = await makeRequestWithRetry(locationsUrl, "GET");
    
    if (!locationsResponse.items || locationsResponse.items.length === 0) {
      console.log(`No location items found for item ${itemId}`);
      return [];
    }
    
    const totalLocations = locationsResponse.items.length;
    console.log(`Found ${totalLocations} location entries for item ${itemId}`);
    
    // If there are too many locations, consider limiting them
    const MAX_LOCATIONS = 50; // Limit to 50 locations to avoid too many API calls
    const locationsToFetch = totalLocations > MAX_LOCATIONS ? 
      locationsResponse.items.slice(0, MAX_LOCATIONS) : 
      locationsResponse.items;
    
    if (totalLocations > MAX_LOCATIONS) {
      console.log(`⚠️ Limiting to first ${MAX_LOCATIONS} locations out of ${totalLocations} to avoid rate limiting`);
    }
    
    const locations = [];
    let processed = 0;
    const batchSize = RATE_LIMIT_CONFIG.batchSize;
    
    console.log(`Processing locations in batches of ${batchSize}...`);
    
    // Process locations in batches with delays
    for (let i = 0; i < locationsToFetch.length; i += batchSize) {
      const batch = locationsToFetch.slice(i, i + batchSize);
      const batchPromises = batch.map(item => {
        if (item.links && item.links[0] && item.links[0].href) {
          return fetchLocationDetails(itemId, item.links[0].href);
        }
        return Promise.resolve(null);
      });
      
      const batchResults = await Promise.all(batchPromises);
      const validLocations = batchResults.filter(location => location !== null);
      locations.push(...validLocations);
      processed += validLocations.length;
      
      console.log(`   Processed ${processed}/${locationsToFetch.length} locations`);
      
      // Add longer delay between batches
      if (i + batchSize < locationsToFetch.length) {
        const delay = RATE_LIMIT_CONFIG.delayBetweenBatches;
        console.log(`   ⏳ Waiting ${delay/1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    console.log(`✅ Successfully fetched ${locations.length} location details for item ${itemId}`);
    
    // Summary of fetch results
    if (locations.length < locationsToFetch.length) {
      console.log(`⚠️ Note: ${locationsToFetch.length - locations.length} locations failed to fetch due to rate limiting or errors`);
    }
    
    return locations;
  } catch (error) {
    console.error(`Error fetching locations for item ${itemId}:`, error.message);
    return [];
  }
}

// Function to fetch single inventory item details with retry
async function fetchInventoryItemById(itemId) {
  try {
    const url = `${netsuiteConfig.baseUrl}/inventoryitem/${itemId}`;
    console.log(`Fetching item ${itemId} from NetSuite...`);
    
    const data = await makeRequestWithRetry(url, "GET");
    console.log(`✅ Successfully fetched item ${itemId}`);
    return data;
  } catch (error) {
    console.error(`❌ Error fetching item ${itemId}:`, error.message);
    
    if (error.response) {
      if (error.response.status === 404) {
        throw new Error(`Item ${itemId} not found in NetSuite`);
      }
      if (error.response.status === 429) {
        throw new Error(`Rate limited while fetching item ${itemId}. Please try again later.`);
      }
    }
    
    throw new Error(`Failed to fetch item ${itemId}: ${error.message}`);
  }
}

// Function to transform NetSuite data to our schema
function transformInventoryData(netSuiteData, priceData, locationsData = []) {
  // Parse dates
  let createdDate = null;
  let lastModifiedDate = null;
  
  try {
    if (netSuiteData.createdDate) {
      createdDate = new Date(netSuiteData.createdDate);
    }
    if (netSuiteData.lastModifiedDate) {
      lastModifiedDate = new Date(netSuiteData.lastModifiedDate);
    }
  } catch (error) {
    console.error("Error parsing dates:", error);
  }
  
  // Extract financial data
  const averageCost = extractNumericValue(netSuiteData, 'averageCost');
  const totalValue = extractNumericValue(netSuiteData, 'totalValue');
  
  // Calculate total quantity from locations
  const totalQuantity = locationsData.reduce((sum, location) => sum + (location.quantityAvailable || 0), 0);
  
  return {
    internalId: netSuiteData.internalId || parseInt(netSuiteData.id) || 0,
    omtisId: extractValue(netSuiteData, 'custitem_wineid'),
    unitType: extractValue(netSuiteData, 'unitsType.refName'),
    itemName: netSuiteData.itemId || '',
    replenishmentId: extractValue(netSuiteData, 'custitem86'),
    purchaseDescription: netSuiteData.purchaseDescription || '',
    productDescription: extractValue(netSuiteData, 'custitem_product_desc'),
    inventoryCategory: extractValue(netSuiteData, 'custitem_inventory_category.refName'),
    inventorySubcategory: extractValue(netSuiteData, 'custitem_inventory_subcategory.refName'),
    omtisWineCategory: extractValue(netSuiteData, 'custitem20.refName'),
    producer: extractValue(netSuiteData, 'custitem15.refName'),
    omtisNameDetail: extractValue(netSuiteData, 'custitemliveexwinename'),
    omtisName: extractValue(netSuiteData, 'custitem26.refName'),
    classification: extractValue(netSuiteData, 'custitem_classification.refName'),
    vintage: extractValue(netSuiteData, 'custitem3'),
    appellation: extractValue(netSuiteData, 'custitem_wine_appellation.refName'),
    bottleSize: extractValue(netSuiteData, 'custitem19.refName'),
    subRegion: extractValue(netSuiteData, 'custitem_sub_region.refName'),
    itemWeight: netSuiteData.weight || 0,
    weightUnit: extractValue(netSuiteData, 'weightUnit.refName'),
    region: extractValue(netSuiteData, 'custitem_region.refName'),
    country: extractValue(netSuiteData, 'custitem9.refName'),
    type: extractValue(netSuiteData, 'custitem_type.refName'),
    price: priceData.price || 0,
    currency: priceData.currency || "HKD",
    
    // Pricing field
    pricing: {
      tradePrice: priceData.tradePrice || 0,
      retailPrice: priceData.retailPrice || 0
    },
    
    // Direct financial fields
    averageCost: averageCost,
    totalValue: totalValue,
    
    // Locations data
    locations: locationsData,
    totalQuantity: totalQuantity,
    
    // Dates
    createdDate: createdDate,
    lastModifiedDate: lastModifiedDate,
    
    // Raw data for debugging
    // rawData: JSON.stringify(netSuiteData),
    lastSynced: new Date()
  };
}

// Main function to sync single inventory item with optional location fetching
async function syncSingleItem(itemId, fetchLocations = true) {
  try {
    console.log(`🔧 Syncing inventory item ID: ${itemId}`);
    console.log("=".repeat(50));
    
    // Validate itemId
    if (!itemId || itemId.trim() === '') {
      throw new Error('Item ID is required');
    }
    
    const numericId = parseInt(itemId);
    if (isNaN(numericId)) {
      throw new Error(`Invalid item ID: ${itemId}. Must be a number.`);
    }
    
    // Check if item already exists
    const existingItem = await InventoryItem.findOne({ internalId: numericId });
    const operation = existingItem ? 'Updating' : 'Creating new';
    console.log(`${operation} item ${itemId}...`);
    
    // Fetch item details from NetSuite
    const netSuiteData = await fetchInventoryItemById(itemId);
    
    // Fetch price information
    let priceData = {
      price: 0,
      currency: "HKD",
      tradePrice: 0,
      retailPrice: 0
    };
    
    if (netSuiteData.price && netSuiteData.price.links && netSuiteData.price.links.length > 0) {
      priceData = await fetchPriceInformation(itemId, netSuiteData.price.links[0].href);
    }
    
    // Fetch locations information (optional)
    let locationsData = [];
    let locationFetchTime = 0;
    
    if (fetchLocations && netSuiteData.locations && netSuiteData.locations.links && netSuiteData.locations.links.length > 0) {
      console.log('\n📍 Starting location data fetch...');
      const startTime = Date.now();
      const locationsUrl = netSuiteData.locations.links[0].href;
      locationsData = await fetchItemLocations(itemId, locationsUrl);
      locationFetchTime = Date.now() - startTime;
      console.log(`📍 Location fetch completed in ${Math.round(locationFetchTime / 1000)} seconds`);
    } else if (!fetchLocations) {
      console.log('\n📍 Skipping location fetch as requested');
    } else {
      console.log('\n📍 No location data available for this item');
    }
    
    // Transform data
    const transformedData = transformInventoryData(netSuiteData, priceData, locationsData);
    
    // Save to MongoDB
    const result = await InventoryItem.findOneAndUpdate(
      { internalId: numericId },
      transformedData,
      { 
        upsert: true, 
        new: true, 
        runValidators: true
      }
    );
    
    console.log(`✅ Successfully ${existingItem ? 'updated' : 'created'} item ${itemId}`);
    
    // Display summary
    console.log("\n📋 Item Summary:");
    console.log("=".repeat(50));
    console.log(`Name: ${result.itemName}`);
    console.log(`Producer: ${result.producer}`);
    console.log(`Vintage: ${result.vintage}`);
    console.log(`Country: ${result.country}`);
    
    if (result.price > 0) {
      console.log(`Price: ${result.price} ${result.currency}`);
    }
    
    if (result.pricing.tradePrice > 0) {
      console.log(`Trade Price: ${result.pricing.tradePrice}`);
    }
    
    if (result.pricing.retailPrice > 0) {
      console.log(`Retail Price: ${result.pricing.retailPrice}`);
    }
    
    if (result.averageCost > 0) {
      console.log(`Avg Cost: ${result.averageCost.toFixed(2)}`);
    }
    
    if (result.totalValue > 0) {
      console.log(`Total Value: ${result.totalValue.toFixed(2)}`);
    }
    
    // Display location summary
    console.log("\n📍 Location Summary:");
    console.log("-".repeat(30));
    console.log(`Total Locations: ${result.locations?.length || 0}`);
    console.log(`Total Quantity Available: ${result.totalQuantity || 0}`);
    
    if (locationFetchTime > 0) {
      console.log(`Location fetch time: ${Math.round(locationFetchTime / 1000)}s`);
    }
    
    if (result.locations && result.locations.length > 0) {
      console.log("\n📊 Top 5 Locations by Quantity:");
      const sortedLocations = [...result.locations]
        .sort((a, b) => b.quantityAvailable - a.quantityAvailable)
        .slice(0, 5);
      
      sortedLocations.forEach((loc, idx) => {
        console.log(`   ${idx + 1}. ${loc.location} (${loc.locationId})`);
        console.log(`      Address: ${loc.address}, ${loc.city}, ${loc.country} ${loc.zip}`);
        console.log(`      On Hand: ${loc.quantityOnHand}, Available: ${loc.quantityAvailable}`);
      });
    }
    
    console.log(`\nLast Synced: ${result.lastSynced.toLocaleString()}`);
    console.log("=".repeat(50));
    
    return {
      success: true,
      internalId: result.internalId,
      itemName: result.itemName,
      locationsCount: result.locations?.length || 0,
      totalQuantity: result.totalQuantity || 0,
      locationFetchTime: Math.round(locationFetchTime / 1000),
      operation: existingItem ? 'updated' : 'created'
    };
    
  } catch (error) {
    console.error(`❌ Error syncing item ${itemId}:`, error.message);
    return {
      success: false,
      error: error.message,
      itemId: itemId
    };
  }
}

// Function to check item details
async function checkItem(itemId) {
  try {
    const numericId = parseInt(itemId);
    const item = await InventoryItem.findOne({ internalId: numericId });
    
    if (!item) {
      console.log(`❌ Item ${itemId} not found in database`);
      return { exists: false };
    }
    
    console.log(`✅ Found item ${itemId} in database`);
    console.log("=".repeat(50));
    console.log("📋 Item Details:");
    console.log("=".repeat(30));
    console.log(`ID: ${item.internalId}`);
    console.log(`Name: ${item.itemName}`);
    console.log(`Producer: ${item.producer}`);
    console.log(`Vintage: ${item.vintage}`);
    console.log(`Country: ${item.country}`);
    console.log(`Type: ${item.type}`);
    console.log(`Price: ${item.price} ${item.currency}`);
    console.log(`Trade Price: ${item.pricing.tradePrice}`);
    console.log(`Retail Price: ${item.pricing.retailPrice}`);
    console.log(`Avg Cost: ${item.averageCost}`);
    console.log(`Total Value: ${item.totalValue}`);
    console.log(`Created: ${item.createdDate ? item.createdDate.toLocaleDateString() : 'N/A'}`);
    console.log(`Modified: ${item.lastModifiedDate ? item.lastModifiedDate.toLocaleDateString() : 'N/A'}`);
    console.log(`Last Synced: ${item.lastSynced.toLocaleString()}`);
    
    // Display location information
    console.log("\n📍 Location Information:");
    console.log("-".repeat(30));
    console.log(`Total Locations: ${item.locations?.length || 0}`);
    console.log(`Total Quantity Available: ${item.totalQuantity || 0}`);
    
    if (item.locations && item.locations.length > 0) {
      console.log("\n📊 All Locations:");
      item.locations.forEach((loc, idx) => {
        console.log(`\n   ${idx + 1}. ${loc.location} (ID: ${loc.locationId})`);
        console.log(`      Address: ${loc.address}`);
        console.log(`      City: ${loc.city}`);
        console.log(`      Country: ${loc.country}`);
        console.log(`      ZIP: ${loc.zip}`);
        console.log(`      On Hand: ${loc.quantityOnHand}`);
        console.log(`      Available: ${loc.quantityAvailable}`);
      });
    }
    
    console.log("=".repeat(50));
    
    return { exists: true, data: item };
    
  } catch (error) {
    console.error(`Error checking item ${itemId}:`, error.message);
    return { exists: false, error: error.message };
  }
}

// Function to delete item
async function deleteItem(itemId) {
  try {
    const numericId = parseInt(itemId);
    const result = await InventoryItem.deleteOne({ internalId: numericId });
    
    if (result.deletedCount === 0) {
      console.log(`❌ Item ${itemId} not found in database`);
      return { success: false, message: "Item not found" };
    }
    
    console.log(`✅ Successfully deleted item ${itemId}`);
    return { success: true, deletedCount: result.deletedCount };
    
  } catch (error) {
    console.error(`Error deleting item ${itemId}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    return { mode: 'help' };
  }
  
  // Check for flags
  if (args[0] === '--check' || args[0] === '-c') {
    return { 
      mode: 'check', 
      itemId: args[1],
      fetchLocations: args.includes('--locations') || args.includes('-l')
    };
  }
  
  if (args[0] === '--delete' || args[0] === '-d') {
    return { 
      mode: 'delete', 
      itemId: args[1] 
    };
  }
  
  if (args[0] === '--help' || args[0] === '-h') {
    return { mode: 'help' };
  }
  
  // Check for no-locations flag
  const noLocations = args.includes('--no-locations') || args.includes('-n');
  
  // Default is sync
  return { 
    mode: 'sync', 
    itemId: args[0],
    fetchLocations: !noLocations
  };
}

// Display help
function showHelp() {
  console.log(`
📦 NetSuite Single Item Sync Tool
=====================================

Usage:
  node scripts/syncSingleItem.js <itemId>          Sync with locations (default)
  node scripts/syncSingleItem.js <itemId> --no-locations  Sync without locations
  node scripts/syncSingleItem.js --check <itemId>  Check item in database
  node scripts/syncSingleItem.js --delete <itemId> Delete item from database

Options:
  -n, --no-locations    Skip location data fetch (faster, avoids rate limiting)
  -c, --check <id>      Check existing item in database
  -d, --delete <id>     Delete item from database
  -h, --help           Show this help message

Examples:
  node scripts/syncSingleItem.js 27707              Sync item 27707 with locations
  node scripts/syncSingleItem.js 27707 -n           Sync without locations (fast)
  node scripts/syncSingleItem.js --check 27707      Check item details
  node scripts/syncSingleItem.js --delete 27707     Delete item

Important:
  - Location fetching makes 2 API calls per location
  - Rate limiting (429 errors) are common with many locations
  - Use --no-locations for faster syncs
  - Script includes exponential backoff for rate limits
  - Locations limited to 50 max to avoid excessive API calls
  `);
}

// Main execution
async function main() {
  try {
    const args = parseArgs();
    
    if (args.mode === 'help') {
      showHelp();
      process.exit(0);
    }
    
    if (!args.itemId) {
      console.error('❌ Error: Item ID is required');
      showHelp();
      process.exit(1);
    }
    
    // Connect to database
    await connectDB();
    console.log('✅ Connected to database');
    
    // Execute based on mode
    let result;
    switch (args.mode) {
      case 'sync':
        if (args.fetchLocations) {
          console.log('⚠️  Note: Fetching location data (may take several minutes due to rate limiting)...');
          console.log('   Use --no-locations for faster sync without location data');
        } else {
          console.log('📍 Location fetching disabled (--no-locations flag used)');
        }
        result = await syncSingleItem(args.itemId, args.fetchLocations);
        break;
      case 'check':
        result = await checkItem(args.itemId);
        break;
      case 'delete':
        result = await deleteItem(args.itemId);
        break;
    }
    
    if (result && !result.success && result.error) {
      console.error(`❌ Operation failed: ${result.error}`);
      process.exit(1);
    }
    
    console.log('🏁 Operation completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('💥 Script failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}

// Export for use in other modules
export { syncSingleItem, checkItem, deleteItem };