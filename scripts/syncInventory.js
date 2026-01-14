import axios from "axios";
import InventoryItem from "../models/InventoryItem.js";
import SalesOrder from "../models/SalesOrder.js";
import { netsuiteConfig, generateOAuthHeaders } from "../config/netsuite.js";
import { connectDB } from "../config/db.js";
import Bottleneck from "bottleneck";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================
// NetSuite Rate Limiter
// =========================
const limiter = new Bottleneck({
  maxConcurrent: 1,   // NetSuite-safe
  minTime: 1200       // 1.2 sec gap between calls
});

async function netsuiteRequest(config, retries = 3) {
  try {
    return await limiter.schedule(() => axios(config));
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      const wait = (4 - retries) * 5000;
      console.warn(`⚠️ 429 Rate limit hit. Retrying in ${wait} ms...`);
      await new Promise(r => setTimeout(r, wait));
      return netsuiteRequest(config, retries - 1);
    }
    throw err;
  }
}

// Connect to MongoDB
await connectDB();

// =========================
// Logging Helper Functions
// =========================
const LOGS_DIR = path.join(__dirname, '..', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Function to write error log to file
function writeErrorLog(itemId, error, logFilePath) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] Item ID: ${itemId} - Error: ${error}\n`;
    fs.appendFileSync(logFilePath, logEntry, 'utf8');
  } catch (writeError) {
    console.error(`Failed to write to log file: ${writeError.message}`);
  }
}

// Function to write sync start log
function writeSyncStartLog(logFilePath, totalItems) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `\n${'='.repeat(80)}\n[${timestamp}] SYNC STARTED - Total items to process: ${totalItems}\n${'='.repeat(80)}\n`;
    fs.appendFileSync(logFilePath, logEntry, 'utf8');
  } catch (writeError) {
    console.error(`Failed to write to log file: ${writeError.message}`);
  }
}

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

// Helper function to extract numeric value from NetSuite response
const extractNumericValue = (data, fieldName) => {
  // Direct access to the field since it's at root level
  if (data && fieldName in data) {
    const value = data[fieldName];
    
    // Check if value exists and is a number or can be converted to number
    if (value === null || value === undefined) {
      return 0.0;
    }
    
    // If it's already a number
    if (typeof value === 'number') {
      return value;
    }
    
    // If it's a string, try to parse it
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? 0.0 : parsed;
    }
    
    return 0.0;
  }
  
  return 0.0;
};

// Function to fetch inventory items by date range
async function fetchInventoryItems(date) {
  try {
    const syncDate = date || netsuiteConfig.syncDate;
    const encodedDate = encodeURIComponent(syncDate);

    const url = `${netsuiteConfig.baseUrl}/inventoryItem?q=lastModifiedDate%20AFTER%20"${encodedDate}"&limit=1000`;

    const headers = {
      Authorization: generateOAuthHeaders(url, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    const response = await netsuiteRequest({
      method: "GET",
      url,
      headers,
      timeout: 30000
    });

    return response.data?.items || [];
  } catch (error) {
    console.error("Error fetching inventory items:", error.message);
    return [];
  }
}

// Function to fetch all inventory items with pagination and batching (no date filter)
async function fetchAllInventoryItems(options = {}) {
  try {
    const {
      batchSize = 1000,        // Items per API request
      maxItems = null,          // Maximum total items to fetch (null = no limit)
      batchDelay = 200         // Delay between batches in ms
    } = options;
    
    let allItems = [];
    let hasMore = true;
    let offset = 0;
    const limit = Math.min(batchSize, 1000); // NetSuite max limit is 1000
    let totalResults = null;
    let batchNumber = 0;
    
    console.log("🔄 Starting pagination to fetch all inventory items...");
    console.log(`📦 Batch configuration: ${limit} items per batch${maxItems ? `, max ${maxItems} items` : ''}`);
    
    while (hasMore) {
      try {
        // Check if we've reached the max items limit
        if (maxItems !== null && allItems.length >= maxItems) {
          console.log(`⏹️  Reached max items limit (${maxItems}). Stopping fetch.`);
          allItems = allItems.slice(0, maxItems);
          break;
        }
        
        batchNumber++;
        const itemsToFetch = maxItems !== null 
          ? Math.min(limit, maxItems - allItems.length)
          : limit;
        
        // Build URL with only limit and offset parameters (no date filter)
        const url = `${netsuiteConfig.baseUrl}/inventoryItem?limit=${itemsToFetch}&offset=${offset}`;
        
        const headers = {
          Authorization: generateOAuthHeaders(url, "GET"),
          "Content-Type": "application/json",
          Accept: "application/json"
        };
        
        const response = await netsuiteRequest({
          method: "GET",
          url,
          headers,
          timeout: 30000
        });
        
        const responseData = response.data || {};
        const items = responseData.items || [];
        allItems = allItems.concat(items);
        
        // Get totalResults from first response
        if (totalResults === null && responseData.totalResults !== undefined) {
          totalResults = responseData.totalResults;
          console.log(`📊 Total items available in NetSuite: ${totalResults}`);
        }
        
        // Check if there are more items using hasMore from response
        hasMore = responseData.hasMore === true;
        
        // Update offset for next request
        offset += items.length;
        
        // Progress logging
        if (totalResults !== null) {
          const progressPercent = ((allItems.length / totalResults) * 100).toFixed(1);
          console.log(`✅ Batch ${batchNumber}: Fetched ${allItems.length}/${totalResults} items (${progressPercent}%) - Current batch: ${items.length} items`);
        } else {
          console.log(`✅ Batch ${batchNumber}: Fetched ${allItems.length} items so far... (Current batch: ${items.length} items)`);
        }
        
        // Add a delay between batches to avoid rate limiting
        if (hasMore && (maxItems === null || allItems.length < maxItems)) {
          await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
      } catch (error) {
        console.error(`❌ Error in pagination at offset ${offset} (batch ${batchNumber}):`, error.message);
        // Continue with next batch instead of stopping completely
        offset += limit;
        if (offset > (totalResults || 100000)) {
          // If we've gone way past expected results, stop
          hasMore = false;
        }
      }
    }
    
    console.log(`🎉 Pagination complete. Total items fetched: ${allItems.length}${totalResults !== null ? ` of ${totalResults}` : ''} in ${batchNumber} batch(es)`);
    
    if (totalResults !== null && allItems.length !== totalResults && maxItems === null) {
      console.warn(`⚠️  Warning: Expected ${totalResults} items but fetched ${allItems.length} items`);
    }
    
    return allItems;
  } catch (error) {
    console.error("Error fetching all inventory items:", error.message);
    return [];
  }
}
 

async function fetchInventoryItemDetail(itemId) {
  try {
    const url = `${netsuiteConfig.baseUrl}/inventoryitem/${itemId}`;

    const headers = {
      Authorization: generateOAuthHeaders(url, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    const response = await netsuiteRequest({
      method: "GET",
      url,
      headers,
      timeout: 30000
    });

    // Check if item is inactive immediately - skip expensive operations if inactive
    if (response.data?.isInactive === true) {
      // Return early with inactive flag, don't fetch price/location data
      return {
        ...response.data,
        isInactive: true,
        priceData: {
          price: 0,
          currency: "HKD",
          tradePrice: 0,
          retailPrice: 0
        },
        locationsData: [],
        totalQuantity: 0
      };
    }

    let priceData = {
      price: 0,
      currency: "HKD",
      tradePrice: 0,
      retailPrice: 0
    };

    if (response.data.price?.links?.length) {
      priceData = await fetchPriceInformation(
        itemId,
        response.data.price.links[0].href,
        response.data.currency?.refName
      );
    }

    let locationsData = [];
    let totalQuantity = 0;

    if (response.data.locations?.links?.length) {
      locationsData = await fetchItemLocations(
        itemId,
        response.data.locations.links[0].href
      );
      totalQuantity = locationsData.reduce(
        (sum, loc) => sum + (loc.quantityAvailable || 0),
        0
      );
    }

    return {
      ...response.data,
      priceData,
      locationsData,
      totalQuantity
    };
  } catch (error) {
    console.error(`Error fetching item ${itemId}:`, error.message);
    return null;
  }
}


// Add this helper function for logging location summary
function logLocationSummary(locations) {
  if (!locations || locations.length === 0) {
    console.log("   No location data available");
    return;
  }
  
  const totalQuantity = locations.reduce((sum, loc) => sum + (loc.quantityAvailable || 0), 0);
  const totalOnHand = locations.reduce((sum, loc) => sum + (loc.quantityOnHand || 0), 0);
  
  console.log(`   Total locations: ${locations.length}`);
  console.log(`   Total quantity available: ${totalQuantity}`);
  console.log(`   Total quantity on hand: ${totalOnHand}`);
  
  // Group by country
  const countries = {};
  locations.forEach(loc => {
    const country = loc.country || 'Unknown';
    countries[country] = (countries[country] || 0) + (loc.quantityAvailable || 0);
  });
  
  if (Object.keys(countries).length > 0) {
    console.log(`   Quantity by country:`);
    Object.entries(countries).forEach(([country, qty]) => {
      console.log(`     - ${country}: ${qty}`);
    });
  }
}

// Helper function to fetch price information
async function fetchPriceInformation(itemId, priceUrl, itemCurrency) {
  try {
    const headers = {
      Authorization: generateOAuthHeaders(priceUrl, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    const priceResponse = await netsuiteRequest({
      method: "GET",
      url: priceUrl,
      headers,
      timeout: 30000
    });

    let price = 0;
    let currency = "HKD";
    let tradePrice = 0;
    let retailPrice = 0;
    let hasTradePrice = false;
    let hasRetailPrice = false;

    if (itemCurrency?.includes("EUR")) currency = "EUR";
    else if (itemCurrency?.includes("USD")) currency = "USD";

    for (const priceItem of priceResponse.data.items || []) {
      if (hasTradePrice && hasRetailPrice) break;

      const detail = await fetchPriceDetail(
        itemId,
        priceItem.links[0].href
      );

      if (!detail) continue;

      if (detail.priceLevelName === "WLP (Base)") {
        tradePrice = detail.price || 0;
        hasTradePrice = true;
      }

      if (detail.priceLevelName === "LPCP (HKD)") {
        retailPrice = detail.price || 0;
        price = retailPrice;
        currency = "HKD";
        hasRetailPrice = true;
      }
    }

    if (!price && tradePrice) price = tradePrice;

    return {
      price,
      currency,
      tradePrice,
      retailPrice
    };
  } catch (error) {
    console.error(`Error fetching price for item ${itemId}:`, error.message);
    return {
      price: 0,
      currency: "HKD",
      tradePrice: 0,
      retailPrice: 0
    };
  }
}


// Helper function to fetch individual price detail
async function fetchPriceDetail(itemId, priceDetailUrl) {
  try {
    const headers = {
      Authorization: generateOAuthHeaders(priceDetailUrl, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    const response = await netsuiteRequest({
      method: "GET",
      url: priceDetailUrl,
      headers,
      timeout: 30000
    });

    return response.data;
  } catch (error) {
    return null;
  }
}


async function fetchItemLocations(itemId, locationsUrl) {
  try {
    const headers = {
      Authorization: generateOAuthHeaders(locationsUrl, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    const response = await netsuiteRequest({
      method: "GET",
      url: locationsUrl,
      headers,
      timeout: 30000
    });

    const locations = [];

    for (const item of response.data.items || []) {
      const loc = await fetchLocationDetails(itemId, item.links[0].href);
      if (loc) locations.push(loc);
    }

    return locations;
  } catch (error) {
    return [];
  }
}

async function fetchLocationDetails(itemId, locationUrl) {
  try {
    const headers = {
      Authorization: generateOAuthHeaders(locationUrl, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    const response = await netsuiteRequest({
      method: "GET",
      url: locationUrl,
      headers,
      timeout: 30000
    });

    const d = response.data;

    return {
      locationId: d.locationId?.toString() || "",
      location: d.location_display || "",
      quantityOnHand: d.quantityOnHand || 0,
      quantityAvailable: d.quantityAvailable || 0
    };
  } catch {
    return null;
  }
}


// Function to transform NetSuite data to our schema
function transformInventoryData(netSuiteData) {
  // Parse dates
  let createdDate = null;
  let lastModifiedDate = null;
  
  // Get price information
  let price = 0;
  let currency = "HKD";
  let tradePrice = 0;
  let retailPrice = 0;
  // Get locations and total quantity
  let locations = [];
  let totalQuantity = 0;
  
  try {
    if (netSuiteData.priceData) {
      price = netSuiteData.priceData.price || 0;
      currency = netSuiteData.priceData.currency || "HKD";
      tradePrice = netSuiteData.priceData.tradePrice || 0;
      retailPrice = netSuiteData.priceData.retailPrice || 0;
    }


    if (netSuiteData.locationsData) {
      locations = netSuiteData.locationsData;
      totalQuantity = netSuiteData.totalQuantity || 0;
    }

    if (netSuiteData.createdDate) {
      createdDate = new Date(netSuiteData.createdDate);
    }
    if (netSuiteData.lastModifiedDate) {
      lastModifiedDate = new Date(netSuiteData.lastModifiedDate);
    }
  } catch (error) {
    console.error("Error parsing dates:", error);
  }
  
  // Extract financial data directly from NetSuite response
  const averageCost = extractNumericValue(netSuiteData, 'averageCost');
  const totalValue = extractNumericValue(netSuiteData, 'totalValue');
  
  console.log(`💰 Financial data for item ${netSuiteData.internalId || netSuiteData.id}:`);
  console.log(`   averageCost: ${averageCost}`);
  console.log(`   totalValue: ${totalValue}`);
  console.log(`   tradePrice: ${tradePrice}`);
  console.log(`   retailPrice: ${retailPrice}`);
  
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
    price: price,
    currency: currency,
    
    // New pricing field
    pricing: {
      tradePrice: tradePrice,
      retailPrice: retailPrice
    },
        locations: locations,
    totalQuantity: totalQuantity,
    
    // Direct financial fields from NetSuite API
    averageCost: averageCost,
    totalValue: totalValue,
    
    // Dates
    createdDate: createdDate,
    lastModifiedDate: lastModifiedDate,
    
    // Raw data for debugging
    // rawData: JSON.stringify(netSuiteData),
    lastSynced: new Date()
  };
}

// Log financial summary
function logFinancialSummary(items) {
  if (items.length === 0) return;
  
  let totalAverageCost = 0;
  let totalValue = 0;
  let itemsWithCost = 0;
  let itemsWithValue = 0;
   let itemsWithTradePrice = 0;
  let itemsWithRetailPrice = 0;
  let totalTradePrice = 0;
  let totalRetailPrice = 0;
  
  items.forEach(item => {
    if (item.averageCost && item.averageCost > 0) {
      totalAverageCost += item.averageCost;
      itemsWithCost++;
    }
    if (item.totalValue && item.totalValue > 0) {
      totalValue += item.totalValue;
      itemsWithValue++;
    }
  });

   items.forEach(item => {
    if (item.pricing && item.pricing.tradePrice > 0) {
      totalTradePrice += item.pricing.tradePrice;
      itemsWithTradePrice++;
    }
    if (item.pricing && item.pricing.retailPrice > 0) {
      totalRetailPrice += item.pricing.retailPrice;
      itemsWithRetailPrice++;
    }
  });
  
  console.log("\n💰 Financial Summary from NetSuite API:");
  console.log(`   Items with average cost data: ${itemsWithCost}/${items.length}`);
  console.log(`   Items with total value data: ${itemsWithValue}/${items.length}`);

  console.log("\n💵 Pricing Summary:");
  console.log(`   Items with trade price: ${itemsWithTradePrice}/${items.length}`);
  console.log(`   Items with retail price: ${itemsWithRetailPrice}/${items.length}`);
  
  if (itemsWithTradePrice > 0) {
    console.log(`   Total trade price sum: ${totalTradePrice.toFixed(2)}`);
    console.log(`   Average trade price: ${(totalTradePrice / itemsWithTradePrice).toFixed(2)}`);
  }
  
  if (itemsWithRetailPrice > 0) {
    console.log(`   Total retail price sum: ${totalRetailPrice.toFixed(2)}`);
    console.log(`   Average retail price: ${(totalRetailPrice / itemsWithRetailPrice).toFixed(2)}`);
  }
  
  if (itemsWithCost > 0) {
    console.log(`   Total average cost: ${totalAverageCost.toFixed(2)}`);
    console.log(`   Average cost per item: ${(totalAverageCost / itemsWithCost).toFixed(2)}`);
  }
  
  if (itemsWithValue > 0) {
    console.log(`   Total value: ${totalValue.toFixed(2)}`);
    console.log(`   Average value per item: ${(totalValue / itemsWithValue).toFixed(2)}`);
  }
  
  // Show sample items with high values
  const itemsWithValueSorted = [...items]
    .filter(item => item.totalValue > 0)
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, 3);
  
  if (itemsWithValueSorted.length > 0) {
    console.log("\n🏆 Top items by total value:");
    itemsWithValueSorted.forEach((item, index) => {
      console.log(`   ${index + 1}. ${item.itemName?.substring(0, 40)}... - Value: ${item.totalValue.toFixed(2)}`);
    });
  }
}

// Test authentication function
async function testAuthentication() {
  try {
    const url = `${netsuiteConfig.baseUrl}/inventoryItem?limit=1`;

    const headers = {
      Authorization: generateOAuthHeaders(url, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    await netsuiteRequest({
      method: "GET",
      url,
      headers,
      timeout: 10000
    });

    return true;
  } catch {
    return false;
  }
}


// Main function to sync inventory
async function syncInventory(limit = 10, date = null) {
  try {
    console.log("=== Starting Inventory Sync ===");
    console.log("Configuration:");
    console.log(`- Realm: ${netsuiteConfig.realm}`);
    console.log(`- Base URL: ${netsuiteConfig.baseUrl}`);
    console.log(`- Limit: ${limit} items`);
    console.log(`- Date: ${date || netsuiteConfig.syncDate}`);
    
    // Test authentication first
    const authSuccess = await testAuthentication();
    if (!authSuccess) {
      return {
        success: false,
        error: "Authentication failed. Please check your OAuth credentials.",
        timestamp: new Date().toISOString()
      };
    }
    
    // Step 1: Fetch inventory items
    console.log("\n=== Fetching Inventory Items ===");
    const items = await fetchInventoryItems(date);
    
    if (items.length === 0) {
      console.log("No items to sync");
      return { 
        success: true, 
        message: "No items found matching criteria", 
        processed: 0, 
        saved: 0,
        timestamp: new Date().toISOString()
      };
    }
    
    // Step 2: Process items (limit to specified number)
    const itemsToProcess = items.slice(0, limit);
    let processedCount = 0;
    let savedCount = 0;
    const errors = [];
    const savedItems = [];
    
    console.log(`\n=== Processing ${itemsToProcess.length} Items ===`);
    
    for (const item of itemsToProcess) {
      const itemId = item.id;
      console.log(`\n[${processedCount + 1}/${itemsToProcess.length}] Processing item ID: ${itemId}`);
      
      // Step 3: Fetch detailed item data
      const detailedData = await fetchInventoryItemDetail(itemId);
      
      if (detailedData) {
        // Step 4: Transform data
        const transformedData = transformInventoryData(detailedData);
        
        // Step 5: Save to MongoDB
        try {
          const result = await InventoryItem.findOneAndUpdate(
            { internalId: transformedData.internalId },
            transformedData,
            { 
              upsert: true, 
              new: true, 
              runValidators: true,
              setDefaultsOnInsert: true 
            }
          );
          
          savedCount++;
          savedItems.push(transformedData);
          
          // Log item info with financial data
          const displayName = transformedData.itemName || `Item ${itemId}`;
          const shortName = displayName.length > 40 
            ? displayName.substring(0, 40) + '...' 
            : displayName;
          
          console.log(`✅ Saved: ${shortName}`);
          
          if (transformedData.averageCost > 0) {
            console.log(`   📊 Average Cost: ${transformedData.averageCost.toFixed(2)}`);
          }
          
          if (transformedData.totalValue > 0) {
            console.log(`   💰 Total Value: ${transformedData.totalValue.toFixed(2)}`);
          }
          
        } catch (dbError) {
          console.error(`❌ Error saving item ${itemId}:`, dbError.message);
          errors.push({ itemId, error: dbError.message });
        }
      } else {
        console.error(`❌ Failed to fetch details for item ${itemId}`);
        errors.push({ itemId, error: "Failed to fetch details" });
      }
      
      processedCount++;
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log("\n" + "=".repeat(50));
    console.log("📦 SYNC COMPLETE");
    console.log("=".repeat(50));
    console.log(`📊 Processed: ${processedCount} items`);
    console.log(`✅ Saved: ${savedCount} items`);
    console.log(`❌ Failed: ${errors.length} items`);
    
    // Log financial summary
    if (savedItems.length > 0) {
      logFinancialSummary(savedItems);
    }
    
    if (errors.length > 0) {
      console.log("\n⚠️  Errors encountered:");
      errors.forEach(err => console.log(`   - Item ${err.itemId}: ${err.error}`));
    }
    
    return {
      success: true,
      processed: processedCount,
      saved: savedCount,
      failed: errors.length,
      financialSummary: savedItems.length > 0 ? {
        totalAverageCost: savedItems.reduce((sum, item) => sum + (item.averageCost || 0), 0),
        totalValue: savedItems.reduce((sum, item) => sum + (item.totalValue || 0), 0),
        itemsWithCost: savedItems.filter(item => item.averageCost > 0).length,
        itemsWithValue: savedItems.filter(item => item.totalValue > 0).length,
        averageCostPerItem: savedItems.filter(item => item.averageCost > 0).length > 0 
          ? savedItems.reduce((sum, item) => sum + (item.averageCost || 0), 0) / 
            savedItems.filter(item => item.averageCost > 0).length
          : 0,
        averageValuePerItem: savedItems.filter(item => item.totalValue > 0).length > 0
          ? savedItems.reduce((sum, item) => sum + (item.totalValue || 0), 0) / 
            savedItems.filter(item => item.totalValue > 0).length
          : 0
      } : null,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error("\n❌ Error in sync process:", error.message);
    console.error(error.stack);
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Main function to sync ALL inventory items (no limit)
async function syncAllInventory(options = {}) {
  // Create log file with timestamp
  const logFileName = `sync-all-inventory-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  const logFilePath = path.join(LOGS_DIR, logFileName);
  
  // Extract batching options
  const {
    batchSize = 1000,        // Items per API request
    maxItems = null,          // Maximum total items to fetch (null = no limit)
    batchDelay = 200         // Delay between batches in ms
  } = options;
  
  try {
    console.log("=== Starting Full Inventory Sync (ALL ITEMS) ===");
    console.log(`📝 Error log file: ${logFilePath}`);
    console.log("Configuration:");
    console.log(`- Realm: ${netsuiteConfig.realm}`);
    console.log(`- Base URL: ${netsuiteConfig.baseUrl}`);
    console.log(`- Batch Size: ${batchSize} items per batch`);
    console.log(`- Max Items: ${maxItems || 'No limit'}`);
    console.log(`- Batch Delay: ${batchDelay}ms`);
    
    // Test authentication first
    const authSuccess = await testAuthentication();
    if (!authSuccess) {
      return {
        success: false,
        error: "Authentication failed. Please check your OAuth credentials.",
        timestamp: new Date().toISOString()
      };
    }
    
    // Step 1: Fetch ALL inventory items with pagination and batching
    console.log("\n=== Fetching ALL Inventory Items (with pagination and batching) ===");
    const items = await fetchAllInventoryItems({ batchSize, maxItems, batchDelay });
    
    if (items.length === 0) {
      console.log("No items to sync");
      return { 
        success: true, 
        message: "No items found", 
        processed: 0, 
        saved: 0,
        timestamp: new Date().toISOString()
      };
    }
    
    // Write sync start log
    writeSyncStartLog(logFilePath, items.length);
    
    // Step 2: Process ALL items
    let processedCount = 0;
    let savedCount = 0;
    let skippedInactiveCount = 0;
    const errors = [];
    const savedItems = [];
    
    console.log(`\n=== Processing ${items.length} Items (ALL) ===`);
    
    for (const item of items) {
      const itemId = item.id;
      processedCount++;
      
      // Log progress for every item to show it's working
      console.log(`\n[${processedCount}/${items.length}] Processing item ID: ${itemId}...`);
      
      try {
        // Step 3: Fetch detailed item data (includes price and location)
        const detailedData = await fetchInventoryItemDetail(itemId);
        
        if (detailedData) {
          // Skip inactive items instantly
          if (detailedData.isInactive === true) {
            skippedInactiveCount++;
            const displayName = detailedData.itemId || `Item ${itemId}`;
            const shortName = displayName.length > 40 
              ? displayName.substring(0, 40) + '...' 
              : displayName;
            console.log(`  ⏭️  Skipped (inactive): ${shortName}`);
            continue;
          }
          
          // Step 4: Transform data
          const transformedData = transformInventoryData(detailedData);
          
          // Step 5: Save to MongoDB
          try {
            const result = await InventoryItem.findOneAndUpdate(
              { internalId: transformedData.internalId },
              transformedData,
              { 
                upsert: true, 
                new: true, 
                runValidators: true,
                setDefaultsOnInsert: true 
              }
            );
            
            savedCount++;
            savedItems.push(transformedData);
            
            const displayName = transformedData.itemName || `Item ${itemId}`;
            const shortName = displayName.length > 40 
              ? displayName.substring(0, 40) + '...' 
              : displayName;
            console.log(`  ✅ Saved: ${shortName}`);
            
            if (transformedData.averageCost > 0) {
              console.log(`     📊 Average Cost: ${transformedData.averageCost.toFixed(2)}`);
            }
            
            if (transformedData.totalValue > 0) {
              console.log(`     💰 Total Value: ${transformedData.totalValue.toFixed(2)}`);
            }
            
          } catch (dbError) {
            console.error(`  ❌ Error saving item ${itemId}:`, dbError.message);
            errors.push({ itemId, error: dbError.message });
          }
        } else {
          // Item completely failed to fetch - log to file
          const errorMsg = "Failed to fetch details";
          console.error(`  ❌ Failed to fetch details for item ${itemId}`);
          errors.push({ itemId, error: errorMsg });
          writeErrorLog(itemId, errorMsg, logFilePath);
        }
      } catch (error) {
        // Item failed during processing - log to file
        console.error(`  ❌ Error processing item ${itemId}:`, error.message);
        errors.push({ itemId, error: error.message });
        writeErrorLog(itemId, error.message, logFilePath);
      }
      
      // Progress update every 25 items
      if (processedCount % 25 === 0) {
        const progressPercent = ((processedCount / items.length) * 100).toFixed(1);
        console.log(`\n📊 Progress Update: ${processedCount}/${items.length} (${progressPercent}%) - Saved: ${savedCount}, Skipped (inactive): ${skippedInactiveCount}, Errors: ${errors.length}`);
      }
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("📦 FULL SYNC COMPLETE");
    console.log("=".repeat(60));
    console.log(`📊 Total items fetched: ${items.length}`);
    console.log(`🔄 Processed: ${processedCount} items`);
    console.log(`✅ Saved: ${savedCount} items`);
    console.log(`⏭️  Skipped (inactive): ${skippedInactiveCount} items`);
    console.log(`❌ Failed: ${errors.length} items`);
    
    // Log financial summary
    if (savedItems.length > 0) {
      logFinancialSummary(savedItems);
    }
    
    if (errors.length > 0) {
      console.log("\n⚠️  Errors encountered:");
      // Show first 10 errors
      const errorsToShow = errors.slice(0, 10);
      errorsToShow.forEach(err => console.log(`   - Item ${err.itemId}: ${err.error}`));
      if (errors.length > 10) {
        console.log(`   ... and ${errors.length - 10} more errors`);
      }
      console.log(`\n📝 All fetch errors have been logged to: ${logFilePath}`);
    }
    
    // Write sync completion summary to log file
    try {
      const timestamp = new Date().toISOString();
      const summaryEntry = `\n${'='.repeat(80)}\n[${timestamp}] SYNC COMPLETED\nTotal items: ${items.length}\nProcessed: ${processedCount}\nSaved: ${savedCount}\nSkipped (inactive): ${skippedInactiveCount}\nFailed: ${errors.length}\n${'='.repeat(80)}\n`;
      fs.appendFileSync(logFilePath, summaryEntry, 'utf8');
    } catch (writeError) {
      console.error(`Failed to write summary to log file: ${writeError.message}`);
    }
    
    return {
      success: true,
      totalFetched: items.length,
      processed: processedCount,
      saved: savedCount,
      skippedInactive: skippedInactiveCount,
      failed: errors.length,
      logFile: logFilePath,
      financialSummary: savedItems.length > 0 ? {
        totalAverageCost: savedItems.reduce((sum, item) => sum + (item.averageCost || 0), 0),
        totalValue: savedItems.reduce((sum, item) => sum + (item.totalValue || 0), 0),
        itemsWithCost: savedItems.filter(item => item.averageCost > 0).length,
        itemsWithValue: savedItems.filter(item => item.totalValue > 0).length,
        averageCostPerItem: savedItems.filter(item => item.averageCost > 0).length > 0 
          ? savedItems.reduce((sum, item) => sum + (item.averageCost || 0), 0) / 
            savedItems.filter(item => item.averageCost > 0).length
          : 0,
        averageValuePerItem: savedItems.filter(item => item.totalValue > 0).length > 0
          ? savedItems.reduce((sum, item) => sum + (item.totalValue || 0), 0) / 
            savedItems.filter(item => item.totalValue > 0).length
          : 0
      } : null,
      errors: errors.length > 0 ? errors.slice(0, 50) : undefined,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error("\n❌ Error in full sync process:", error.message);
    console.error(error.stack);
    
    // Log the error to file if log file was created
    try {
      if (fs.existsSync(logFilePath)) {
        const timestamp = new Date().toISOString();
        const errorEntry = `\n${'='.repeat(80)}\n[${timestamp}] SYNC FAILED - Fatal Error\nError: ${error.message}\nStack: ${error.stack}\n${'='.repeat(80)}\n`;
        fs.appendFileSync(logFilePath, errorEntry, 'utf8');
      }
    } catch (writeError) {
      console.error(`Failed to write error to log file: ${writeError.message}`);
    }
    
    return {
      success: false,
      error: error.message,
      logFile: fs.existsSync(logFilePath) ? logFilePath : undefined,
      timestamp: new Date().toISOString()
    };
  }
}

// Function to sync inventory items from sales orders
async function syncInventoryFromSalesOrders() {
  try {
    console.log("=== Starting Inventory Sync from Sales Orders ===");
    console.log("=".repeat(60));
    
    // Test authentication first
    const authSuccess = await testAuthentication();
    if (!authSuccess) {
      return {
        success: false,
        error: "Authentication failed. Please check your OAuth credentials.",
        timestamp: new Date().toISOString()
      };
    }
    
    // Step 1: Fetch all sales orders
    console.log("\n📦 Fetching all sales orders from database...");
    const salesOrders = await SalesOrder.find({}).select('items');
    
    if (salesOrders.length === 0) {
      console.log("⚠️ No sales orders found in database");
      return {
        success: true,
        message: "No sales orders found",
        processed: 0,
        saved: 0,
        skipped: 0,
        timestamp: new Date().toISOString()
      };
    }
    
    console.log(`✅ Found ${salesOrders.length} sales orders`);
    
    // Step 2: Extract all unique itemIds from sales orders
    const itemIdSet = new Set();
    salesOrders.forEach(order => {
      if (order.items && Array.isArray(order.items)) {
        order.items.forEach(item => {
          if (item.itemId && item.itemId.trim() !== '') {
            itemIdSet.add(item.itemId.toString());
          }
        });
      }
    });
    
    const uniqueItemIds = Array.from(itemIdSet);
    console.log(`\n📋 Found ${uniqueItemIds.length} unique item IDs in sales orders`);
    
    if (uniqueItemIds.length === 0) {
      return {
        success: true,
        message: "No item IDs found in sales orders",
        processed: 0,
        saved: 0,
        skipped: 0,
        timestamp: new Date().toISOString()
      };
    }
    
    // Step 3: Check which items already exist in InventoryItem collection
    console.log("\n🔍 Checking which items already exist in inventory...");
    const existingItems = await InventoryItem.find({
      internalId: { $in: uniqueItemIds.map(id => parseInt(id)) }
    }).select('internalId');
    
    const existingItemIds = new Set(
      existingItems.map(item => item.internalId.toString())
    );
    
    // Filter out items that already exist
    const itemsToSync = uniqueItemIds.filter(itemId => 
      !existingItemIds.has(itemId.toString())
    );
    
    const skippedCount = uniqueItemIds.length - itemsToSync.length;
    
    console.log(`✅ Found ${existingItems.length} existing items`);
    console.log(`⏭️  Skipping ${skippedCount} items that already exist`);
    console.log(`🔄 Will sync ${itemsToSync.length} new items`);
    
    if (itemsToSync.length === 0) {
      return {
        success: true,
        message: "All items from sales orders already exist in inventory",
        processed: 0,
        saved: 0,
        skipped: skippedCount,
        totalItems: uniqueItemIds.length,
        timestamp: new Date().toISOString()
      };
    }
    
    // Step 4: Fetch and save new items
    let processedCount = 0;
    let savedCount = 0;
    let skippedInactiveCount = 0;
    const errors = [];
    const savedItems = [];
    
    console.log(`\n=== Processing ${itemsToSync.length} New Items ===`);
    
    for (const itemId of itemsToSync) {
      processedCount++;
      console.log(`\n[${processedCount}/${itemsToSync.length}] Processing item ID: ${itemId}`);
      
      try {
        // Fetch detailed item data from NetSuite
        const detailedData = await fetchInventoryItemDetail(itemId);
        
        if (detailedData) {
          // Check if item is inactive - only save items where isInactive is false
          if (detailedData.isInactive !== false) {
            skippedInactiveCount++;
            const displayName = detailedData.itemId || `Item ${itemId}`;
            const shortName = displayName.length > 40 
              ? displayName.substring(0, 40) + '...' 
              : displayName;
            const reason = detailedData.isInactive === true ? 'inactive' : 'isInactive field not false';
            console.log(`⏭️  Skipped (${reason}): ${shortName}`);
            await new Promise(resolve => setTimeout(resolve, 200));
            continue;
          }
          
          // Transform data
          const transformedData = transformInventoryData(detailedData);
          
          // Save to MongoDB
          try {
            const result = await InventoryItem.findOneAndUpdate(
              { internalId: transformedData.internalId },
              transformedData,
              { 
                upsert: true, 
                new: true, 
                runValidators: true,
                setDefaultsOnInsert: true 
              }
            );
            
            savedCount++;
            savedItems.push(transformedData);
            
            // Log item info
            const displayName = transformedData.itemName || `Item ${itemId}`;
            const shortName = displayName.length > 40 
              ? displayName.substring(0, 40) + '...' 
              : displayName;
            
            console.log(`✅ Saved: ${shortName}`);
            
            if (transformedData.averageCost > 0) {
              console.log(`   📊 Average Cost: ${transformedData.averageCost.toFixed(2)}`);
            }
            
            if (transformedData.totalValue > 0) {
              console.log(`   💰 Total Value: ${transformedData.totalValue.toFixed(2)}`);
            }
            
          } catch (dbError) {
            console.error(`❌ Error saving item ${itemId}:`, dbError.message);
            errors.push({ itemId, error: dbError.message });
          }
        } else {
          console.error(`❌ Failed to fetch details for item ${itemId}`);
          errors.push({ itemId, error: "Failed to fetch details" });
        }
      } catch (error) {
        console.error(`❌ Error processing item ${itemId}:`, error.message);
        errors.push({ itemId, error: error.message });
      }
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("📦 SYNC COMPLETE");
    console.log("=".repeat(60));
    console.log(`📊 Total unique items in sales orders: ${uniqueItemIds.length}`);
    console.log(`⏭️  Skipped (already exist): ${skippedCount}`);
    console.log(`🔄 Processed: ${processedCount} items`);
    console.log(`✅ Saved: ${savedCount} items`);
    console.log(`⏭️  Skipped (inactive): ${skippedInactiveCount} items`);
    console.log(`❌ Failed: ${errors.length} items`);
    
    // Log financial summary if items were saved
    if (savedItems.length > 0) {
      logFinancialSummary(savedItems);
    }
    
    if (errors.length > 0) {
      console.log("\n⚠️  Errors encountered:");
      errors.forEach(err => console.log(`   - Item ${err.itemId}: ${err.error}`));
    }
    
    return {
      success: true,
      totalItems: uniqueItemIds.length,
      skipped: skippedCount,
      skippedInactive: skippedInactiveCount,
      processed: processedCount,
      saved: savedCount,
      failed: errors.length,
      financialSummary: savedItems.length > 0 ? {
        totalAverageCost: savedItems.reduce((sum, item) => sum + (item.averageCost || 0), 0),
        totalValue: savedItems.reduce((sum, item) => sum + (item.totalValue || 0), 0),
        itemsWithCost: savedItems.filter(item => item.averageCost > 0).length,
        itemsWithValue: savedItems.filter(item => item.totalValue > 0).length,
        averageCostPerItem: savedItems.filter(item => item.averageCost > 0).length > 0 
          ? savedItems.reduce((sum, item) => sum + (item.averageCost || 0), 0) / 
            savedItems.filter(item => item.averageCost > 0).length
          : 0,
        averageValuePerItem: savedItems.filter(item => item.totalValue > 0).length > 0
          ? savedItems.reduce((sum, item) => sum + (item.totalValue || 0), 0) / 
            savedItems.filter(item => item.totalValue > 0).length
          : 0
      } : null,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error("\n❌ Error in sync process:", error.message);
    console.error(error.stack);
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Function to check existing data with financial stats
async function checkExistingData() {
  try {
    const count = await InventoryItem.countDocuments();
    console.log(`📁 Database contains ${count} items`);
    
    if (count > 0) {
      // Get financial statistics from stored data
      const stats = await InventoryItem.aggregate([
        {
          $group: {
            _id: null,
            totalItems: { $sum: 1 },
            itemsWithCost: { 
              $sum: { 
                $cond: [{ $gt: ["$averageCost", 0] }, 1, 0] 
              } 
            },
            itemsWithValue: { 
              $sum: { 
                $cond: [{ $gt: ["$totalValue", 0] }, 1, 0] 
              } 
            },
            totalAverageCost: { $sum: "$averageCost" },
            totalValue: { $sum: "$totalValue" },
            avgCostPerItem: { $avg: "$averageCost" },
            avgValuePerItem: { $avg: "$totalValue" },
            maxCost: { $max: "$averageCost" },
            minCost: { $min: "$averageCost" },
            maxValue: { $max: "$totalValue" },
            minValue: { $min: "$totalValue" }
          }
        }
      ]);
      
      if (stats.length > 0) {
        const stat = stats[0];
        console.log("\n💰 Financial Summary from Database:");
        console.log(`   Total Items: ${stat.totalItems}`);
        console.log(`   Items with Cost Data: ${stat.itemsWithCost}`);
        console.log(`   Items with Value Data: ${stat.itemsWithValue}`);
        console.log(`   Total Average Cost: ${stat.totalAverageCost.toFixed(2)}`);
        console.log(`   Total Value: ${stat.totalValue.toFixed(2)}`);
        console.log(`   Avg Cost per Item: ${stat.avgCostPerItem.toFixed(2)}`);
        console.log(`   Avg Value per Item: ${stat.avgValuePerItem.toFixed(2)}`);
        
        if (stat.maxCost > 0) {
          console.log(`   Max Average Cost: ${stat.maxCost.toFixed(2)}`);
        }
        if (stat.maxValue > 0) {
          console.log(`   Max Total Value: ${stat.maxValue.toFixed(2)}`);
        }
      }
      
      // Get a sample item with highest value
      const highestValueItem = await InventoryItem.findOne({ totalValue: { $gt: 0 } })
        .sort({ totalValue: -1 })
        .select('internalId itemName vintage totalValue averageCost');
      
      if (highestValueItem) {
        console.log("\n🏆 Highest Value Item:");
        console.log(`   ID: ${highestValueItem.internalId}`);
        console.log(`   Name: ${highestValueItem.itemName?.substring(0, 50)}...`);
        console.log(`   Vintage: ${highestValueItem.vintage}`);
        console.log(`   Total Value: ${highestValueItem.totalValue.toFixed(2)}`);
        console.log(`   Average Cost: ${highestValueItem.averageCost.toFixed(2)}`);
      }
    }
    
    return count;
  } catch (error) {
    console.error("Error checking database:", error);
    return 0;
  }
}

// Run the script directly if called from command line
if (process.argv[1] === new URL(import.meta.url).pathname) {
  async function main() {
    try {
      console.log("🔧 NetSuite Inventory Sync Script");
      console.log("📊 Extracts averageCost and totalValue directly from API");
      console.log("=".repeat(60));
      
      // Check existing data
      await checkExistingData();
      
      // Get parameters from command line
      const limit = process.argv[2] ? parseInt(process.argv[2]) : 10;
      const date = process.argv[3] || null;
      
      console.log(`\n⚙️  Sync Parameters:`);
      console.log(`   Limit: ${limit} items`);
      console.log(`   Date: ${date || netsuiteConfig.syncDate}`);
      
      // Sync new data
      const result = await syncInventory(limit, date);
      
      // Check updated count
      const newCount = await checkExistingData();
      
      console.log("\n" + "=".repeat(60));
      console.log("🏁 Script completed!");
      console.log(`📈 Total items in database: ${newCount}`);
      console.log("=".repeat(60));
      
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error("💥 Script failed:", error);
      process.exit(1);
    }
  }
  
  main();
}

// Export for use in other files
export { syncInventory, syncAllInventory, syncInventoryFromSalesOrders, checkExistingData, testAuthentication };