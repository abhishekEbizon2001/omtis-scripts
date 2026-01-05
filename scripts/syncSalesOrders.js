import axios from "axios";
import SalesOrder from "../models/SalesOrder.js";
import { netsuiteConfig, generateOAuthHeaders } from "../config/netsuite.js";
import { connectDB } from "../config/db.js";
import { netsuiteRequest } from "../utils/netsuiteRequest.js";

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

// Helper function to parse date
const parseDate = (dateString) => {
  if (!dateString) return null;
  try {
    return new Date(dateString);
  } catch (error) {
    return null;
  }
};

// Function to fetch sales orders by date range
async function fetchSalesOrders(date, limit = 10) {
  try {
    const syncDate = date || netsuiteConfig.syncDate;
    const encodedDate = encodeURIComponent(syncDate);
    const url = `${netsuiteConfig.baseUrl}/salesOrder?q=lastModifiedDate%20AFTER%20"${encodedDate}"&limit=${limit}`;

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
    console.error("❌ Error fetching sales orders:", error.message);
    return [];
  }
}


// Function to fetch inventory item details
async function fetchInventoryItemDetails(inventoryItemUrl) {
  try {
    const headers = {
      Authorization: generateOAuthHeaders(inventoryItemUrl, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    const response = await netsuiteRequest({
      method: "GET",
      url: inventoryItemUrl,
      headers,
      timeout: 10000
    });

    return response.data;
  } catch (error) {
    console.error(`   ❌ Error fetching inventory item details:`, error.message);
    return null;
  }
}

// Updated function to fetch sales order items with inventory details
async function fetchSalesOrderItems(salesOrderId) {
  try {
    const itemsUrl = `${netsuiteConfig.baseUrl}/salesorder/${salesOrderId}/item`;

    const headers = {
      Authorization: generateOAuthHeaders(itemsUrl, "GET"),
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    const response = await netsuiteRequest({
      method: "GET",
      url: itemsUrl,
      headers,
      timeout: 15000
    });

    if (!response.data?.items?.length) return [];

    const items = [];

    for (const itemRef of response.data.items) {
      const itemId = itemRef.links[0].href.split("/").pop();
      const itemDetailUrl = `${netsuiteConfig.baseUrl}/salesorder/${salesOrderId}/item/${itemId}`;

      try {
        const itemResponse = await netsuiteRequest({
          method: "GET",
          url: itemDetailUrl,
          headers: {
            Authorization: generateOAuthHeaders(itemDetailUrl, "GET"),
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          timeout: 15000
        });

        const itemData = itemResponse.data;

        // Initialize producer and region
        let producer = "";
        let region = "";

        // If there's an inventory item link, fetch details
        if (itemData.item?.links?.[0]?.href) {
          const inventoryItemUrl = itemData.item.links[0].href;
          try {
            const inventoryItemData = await fetchInventoryItemDetails(inventoryItemUrl);
            
            if (inventoryItemData) {
              // Extract producer from custitem15.refName
              producer = inventoryItemData.custitem15?.refName || "";
              
              // Extract region from custitem_region.refName
              region = inventoryItemData.custitem_region?.refName || "";
              
              console.log(`   📦 Item ${itemId}: Producer=${producer}, Region=${region}`);
            }
          } catch (inventoryError) {
            console.error(`   ⚠️ Could not fetch inventory details for item ${itemId}:`, inventoryError.message);
          }
        }

        items.push({
          itemId: itemData.item?.id || "",
          itemName: itemData.item?.refName || "",
          salesDescription: itemData.description || "",
          omtisId: itemData.custcol17 || "",
          
          // NEW FIELDS
          producer: producer,
          region: region,
          
          quantity: itemData.quantity || 0,
          units: itemData.units || "",
          fulfilled: extractNumericValue(itemData, "quantityFulfilled"),
          invoiced: extractNumericValue(itemData, "quantityBilled"),
          available: itemData.quantityAvailable || 0,
          priceLevel: itemData.price?.refName || "",
          unitPrice: itemData.rate || 0,
          total: itemData.amount || 0,
          grossProfit: itemData.grossProfit || 0,
          line: itemData.line || 0,
          isClosed: itemData.isClosed || false,
          isOpen: itemData.isOpen || false
        });
      } catch (err) {
        console.error(`   ❌ Error fetching item ${itemId}:`, err.message);
      }
    }

    return items;
  } catch (error) {
    console.error("❌ Error fetching order items:", error.message);
    return [];
  }
}


// Function to fetch detailed sales order
async function fetchSalesOrderDetail(salesOrderId) {
  try {
    const url = `${netsuiteConfig.baseUrl}/salesorder/${salesOrderId}`;

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

    return response.data;
  } catch (error) {
    console.error(`❌ Error fetching order ${salesOrderId}:`, error.message);
    return null;
  }
}


// Function to transform sales order data
async function transformSalesOrderData(netSuiteData) {
  // Extract customer information directly from sales order
  const customer = {
    customerId: netSuiteData.entity?.id || '',
    customerName: netSuiteData.entity?.refName || '',
    email: netSuiteData.email || ''
  };
  
  // Parse the customer name to get just the name part
  if (customer.customerName.includes(' ')) {
    const parts = customer.customerName.split(' ');
    if (parts.length >= 2) {
      customer.customerName = parts.slice(1).join(' ');
      // customer.customerId = parts[0];
    }
  }
  
  // Fetch items
  const items = await fetchSalesOrderItems(netSuiteData.id);
  
  return {
    internalId: parseInt(netSuiteData.id) || 0,
    transactionNumber: netSuiteData.tranId || netSuiteData.transactionNumber || '',
    
    // Customer Information (extracted directly from sales order)
    customer: customer,
    
    // Order Information
    orderDate: parseDate(netSuiteData.salesEffectiveDate),
    deliveryDate: parseDate(netSuiteData.shipDate),
    
    // Company Information
    subsidiary: {
      id: netSuiteData.subsidiary?.id || '',
      name: netSuiteData.subsidiary?.refName || ''
    },
    department: {
      id: netSuiteData.department?.id || '',
      name: netSuiteData.department?.refName || ''
    },
    location: {
      id: netSuiteData.location?.id || '',
      name: netSuiteData.location?.refName || ''
    },
    
    // Financial Information
    currency: {
      id: netSuiteData.currency?.id || '',
      name: netSuiteData.currency?.refName || ''
    },
    terms: {
      id: netSuiteData.terms?.id || '',
      name: netSuiteData.terms?.refName || ''
    },
    invoiceNumber: netSuiteData.tranId || '',
    
    // Customer Financial Information (from custom fields)
    customerBalance: extractNumericValue(netSuiteData, 'custbody2'),
    customerBalanceGroup: extractNumericValue(netSuiteData, 'custbody27'),
    creditLimit: extractNumericValue(netSuiteData, 'custbody7'),
    consolidatedOverdueBalance: extractNumericValue(netSuiteData, 'custbody29'),
    consolidatedDaysOverdue: extractNumericValue(netSuiteData, 'custbody28'),
    
    // Order Status
    holdType: {
      id: netSuiteData.custbody37?.id || '',
      name: netSuiteData.custbody37?.refName || ''
    },
    holdExtensionDate: parseDate(netSuiteData.custbodyHoldExtensionDate),
    
    // Shipping Information
    shipTo: netSuiteData.shipAddress || '',
    shipContact: netSuiteData.custbody13 || '',
    
    // Sales Information
    salesRep: {
      id: netSuiteData.salesRep?.id || '',
      name: netSuiteData.salesRep?.refName || ''
    },
    
    // Order Items
    items: items,
    
    // Totals
    subtotal: netSuiteData.subtotal || 0.0,
    discountTotal: netSuiteData.discountTotal || 0.0,
    totalAmount: netSuiteData.total || 0.0,
    estGrossProfit: netSuiteData.estGrossProfit || 0.0,
    estGrossProfitPercent: netSuiteData.estGrossProfitPercent || 0.0,
    
    // Status
    orderStatus: netSuiteData.orderStatus?.id || netSuiteData.status?.id || '',
    
    // Dates
    createdDate: parseDate(netSuiteData.createdDate),
    lastModifiedDate: parseDate(netSuiteData.lastModifiedDate),
    tranDate: parseDate(netSuiteData.tranDate),
    shipDate: parseDate(netSuiteData.shipDate),
    salesEffectiveDate: parseDate(netSuiteData.salesEffectiveDate),
    
    // Raw data for debugging
    // rawData: JSON.stringify(netSuiteData),
    lastSynced: new Date()
  };
}

// Main function to sync sales orders
async function syncSalesOrders(limit = 10, date = null) {
  try {
    console.log("🚀 Starting Sales Orders Sync");
    console.log("=".repeat(50));
    console.log(`📅 Date: ${date || netsuiteConfig.syncDate}`);
    console.log(`🔢 Limit: ${limit} orders`);
    console.log("=".repeat(50));
    
    // Step 1: Fetch sales orders
    console.log("\n📡 Fetching sales orders...");
    const orders = await fetchSalesOrders(date, limit);
    
    if (orders.length === 0) {
      console.log("\n⚠️ No sales orders to sync");
      return { 
        success: true, 
        message: "No sales orders found", 
        processed: 0, 
        saved: 0
      };
    }
    
    // Step 2: Process orders
    let processedCount = 0;
    let savedCount = 0;
    const errors = [];
    const savedOrders = [];
    
    console.log(`\n🔄 Processing ${orders.length} orders...`);
    
    for (const order of orders) {
      const orderId = order.id;
      console.log(`\n[${processedCount + 1}/${orders.length}] Order ID: ${orderId}`);
      
      // Fetch detailed order data
      const detailedData = await fetchSalesOrderDetail(orderId);
      
      if (detailedData) {
        // Transform data
        const transformedData = await transformSalesOrderData(detailedData);
        
        // Save to MongoDB
        try {
          await SalesOrder.findOneAndUpdate(
            { internalId: transformedData.internalId },
            transformedData,
            { 
              upsert: true, 
              new: true, 
              runValidators: true
            }
          );
          
          savedCount++;
          savedOrders.push(transformedData);
          
          console.log(`✅ Saved order ${orderId}`);
          console.log(`   👤 Customer: ${transformedData.customer.customerName}`);
          console.log(`   📅 Date: ${transformedData.orderDate?.toISOString().split('T')[0] || 'N/A'}`);
          console.log(`   💰 Total: ${transformedData.totalAmount.toFixed(2)}`);
          console.log(`   📦 Items: ${transformedData.items.length}`);

          // Add inventory details summary
if (transformedData.items.length > 0) {
  const itemsWithProducer = transformedData.items.filter(item => item.producer).length;
  const itemsWithRegion = transformedData.items.filter(item => item.region).length;
  
  console.log(`   🏭 Items with producer: ${itemsWithProducer}/${transformedData.items.length}`);
  console.log(`   🌍 Items with region: ${itemsWithRegion}/${transformedData.items.length}`);
}
          
        } catch (dbError) {
          console.error(`❌ Error saving order ${orderId}:`, dbError.message);
          errors.push({ orderId, error: dbError.message });
        }
      } else {
        console.error(`❌ Failed to fetch order ${orderId}`);
        errors.push({ orderId, error: "Failed to fetch details" });
      }
      
      processedCount++;
      
      // Add delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Generate summary
    console.log("\n" + "=".repeat(50));
    console.log("📊 SYNC COMPLETE");
    console.log("=".repeat(50));
    console.log(`✅ Processed: ${processedCount}`);
    console.log(`✅ Saved: ${savedCount}`);
    console.log(`❌ Failed: ${errors.length}`);
    
    if (savedOrders.length > 0) {
      const totalAmount = savedOrders.reduce((sum, order) => sum + order.totalAmount, 0);
      const totalItems = savedOrders.reduce((sum, order) => sum + order.items.length, 0);
      
      console.log("\n💰 Summary:");
      console.log(`   Total Sales: ${totalAmount.toFixed(2)}`);
      console.log(`   Avg Order Value: ${(totalAmount / savedOrders.length).toFixed(2)}`);
      console.log(`   Total Line Items: ${totalItems}`);
      console.log(`   Avg Items per Order: ${(totalItems / savedOrders.length).toFixed(1)}`);
    }
    
    return {
      success: true,
      processed: processedCount,
      saved: savedCount,
      failed: errors.length,
      summary: savedOrders.length > 0 ? {
        totalAmount: savedOrders.reduce((sum, order) => sum + order.totalAmount, 0),
        totalOrders: savedOrders.length,
        totalItems: savedOrders.reduce((sum, order) => sum + order.items.length, 0)
      } : null
    };
    
  } catch (error) {
    console.error("\n💥 Error in sync:", error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Function to check existing sales orders
async function checkExistingSalesOrders() {
  try {
    const count = await SalesOrder.countDocuments();
    console.log(`📁 Database: ${count} sales orders`);
    
    if (count > 0) {
      const stats = await SalesOrder.aggregate([
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$totalAmount" },
            avgAmount: { $avg: "$totalAmount" },
            recentDate: { $max: "$orderDate" }
          }
        }
      ]);
      
      if (stats[0]) {
        console.log(`💰 Total Sales: ${stats[0].totalAmount.toFixed(2)}`);
        console.log(`📊 Avg Order: ${stats[0].avgAmount.toFixed(2)}`);
      }
      
      // Show latest order
      const latest = await SalesOrder.findOne()
        .sort({ orderDate: -1 })
        .select('transactionNumber customer.customerName orderDate totalAmount');
      
      if (latest) {
        console.log(`📅 Latest Order: ${latest.transactionNumber}`);
        console.log(`   ${latest.customer.customerName} - ${latest.totalAmount.toFixed(2)}`);
      }
    }
    
    return count;
  } catch (error) {
    console.error("Error checking database:", error);
    return 0;
  }
}

// Run script directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  async function main() {
    console.log("🔧 Sales Orders Sync Script");
    console.log("=".repeat(50));
    
    const limit = process.argv[2] ? parseInt(process.argv[2]) : 10;
    const date = process.argv[3] || null;
    
    await checkExistingSalesOrders();
    await syncSalesOrders(limit, date);
    await checkExistingSalesOrders();
    
    console.log("\n✅ Done!");
  }
  
  main().catch(console.error);
}

export { syncSalesOrders, checkExistingSalesOrders };