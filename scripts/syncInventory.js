import axios from "axios";
import InventoryItem from "../models/InventoryItem.js";
import { netsuiteConfig, generateOAuthHeaders } from "../config/netsuite.js";
import { connectDB } from "../config/db.js";
import Bottleneck from "bottleneck";

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
    rawData: JSON.stringify(netSuiteData),
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
export { syncInventory, checkExistingData, testAuthentication };