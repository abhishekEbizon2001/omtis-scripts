import express from "express";
import dotenv from "dotenv";
import { connectDB } from "./config/db.js";
import { syncInventory, syncAllInventory, syncInventoryFromSalesOrders, testAuthentication } from "./scripts/syncInventory.js";
import { syncSalesOrders } from "./scripts/syncSalesOrders.js";
import { netsuiteRequest } from "./utils/netsuiteRequest.js";
import { generateOAuthHeaders, netsuiteConfig } from "./config/netsuite.js";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Connect to MongoDB
try {
  await connectDB();
  console.log("✅ MongoDB connected successfully");
} catch (error) {
  console.error("❌ MongoDB connection failed:", error.message);
  process.exit(1);
}

app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    message: "NetSuite Sync API is running",
    environment: process.env.NODE_ENV || 'development',
    port: PORT,
    status: "healthy"
  });
});

// Test authentication endpoint
app.get("/api/test-auth", async (req, res) => {
  try {
    const authResult = await testAuthentication();
    
    if (authResult) {
      res.json({
        success: true,
        message: "Authentication successful",
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(401).json({
        success: false,
        message: "Authentication failed",
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Trigger sync endpoint
app.post("/api/sync", async (req, res) => {
  try {
    const limit = req.body.limit || 100;
    const date = req.body.date || process.env.SYNC_DATE || "10/04/2024";
    
    console.log(`\n🔄 Manual sync triggered with limit: ${limit}, date: ${date}`);
    
    // Run sync and wait for result
    const result = await syncInventory(limit, date);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error("Sync endpoint error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Sync ALL inventory items endpoint (no limit)
app.post("/api/sync/all", async (req, res) => {
  try {
    const { batchSize, maxItems, batchDelay } = req.body;
    
    console.log(`\n🔄 Full inventory sync triggered (ALL ITEMS)`);
    console.log("⚠️  This will sync all inventory items from NetSuite - may take a long time...");
    
    if (batchSize || maxItems || batchDelay) {
      console.log(`📦 Batching options: batchSize=${batchSize || 1000}, maxItems=${maxItems || 'unlimited'}, batchDelay=${batchDelay || 200}ms`);
    }
    
    // Run full sync with batching options
    const result = await syncAllInventory({
      batchSize: batchSize || 1000,
      maxItems: maxItems || null,
      batchDelay: batchDelay || 200
    });
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error("Full sync endpoint error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get all inventory items
app.get("/api/inventory", async (req, res) => {
  try {
    const InventoryItem = (await import("./models/InventoryItem.js")).default;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    const items = await InventoryItem.find()
      .sort({ internalId: 1 })
      .skip(skip)
      .limit(limit);
    
    const total = await InventoryItem.countDocuments();
    
    res.json({
      success: true,
      count: items.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      items,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Error fetching inventory:", error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get inventory item by ID
app.get("/api/inventory/:id", async (req, res) => {
  try {
    const InventoryItem = (await import("./models/InventoryItem.js")).default;
    const item = await InventoryItem.findOne({ internalId: req.params.id });
    
    if (!item) {
      return res.status(404).json({ 
        success: false,
        error: "Item not found",
        id: req.params.id,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      item,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Error fetching item:", error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get sync status
app.get("/api/status", async (req, res) => {
  try {
    const InventoryItem = (await import("./models/InventoryItem.js")).default;
    const count = await InventoryItem.countDocuments();
    const lastSyncedItem = await InventoryItem.findOne().sort({ lastSynced: -1 });
    const oldestItem = await InventoryItem.findOne().sort({ lastSynced: 1 });
    
    res.json({
      success: true,
      database: "connected",
      itemsCount: count,
      lastSync: lastSyncedItem?.lastSynced || "Never",
      firstSync: oldestItem?.lastSynced || "Never",
      environment: process.env.NODE_ENV || 'development',
      syncDate: process.env.SYNC_DATE,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message,
      database: "error",
      timestamp: new Date().toISOString()
    });
  }
});

// Clear all data (for testing)
app.delete("/api/inventory", async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        success: false,
        error: "Not allowed in production",
        timestamp: new Date().toISOString()
      });
    }
    
    const InventoryItem = (await import("./models/InventoryItem.js")).default;
    const result = await InventoryItem.deleteMany({});
    
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} items`,
      deletedCount: result.deletedCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Error clearing data:", error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Sales Orders Sync endpoint
app.post("/api/sync/sales-orders", async (req, res) => {
  try {
    const limit = req.body.limit || 10;
    const date = req.body.date || process.env.SYNC_DATE || "10/04/2024";
    
    console.log(`🔄 Sales orders sync: limit=${limit}, date=${date}`);
    
    const result = await syncSalesOrders(limit, date);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// Sync inventory items from sales orders endpoint
app.post("/api/sync/inventory-from-sales-orders", async (req, res) => {
  try {
    console.log(`\n🔄 Syncing inventory items from sales orders...`);
    
    const result = await syncInventoryFromSalesOrders();
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error("Sync inventory from sales orders error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get sales orders
app.get("/api/sales-orders", async (req, res) => {
  try {
    const SalesOrder = (await import("./models/SalesOrder.js")).default;
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    // Build filter
    const filter = {};
    if (req.query.customer) filter['customer.customerName'] = new RegExp(req.query.customer, 'i');
    if (req.query.status) filter.orderStatus = req.query.status;
    if (req.query.fromDate) filter.orderDate = { $gte: new Date(req.query.fromDate) };
    if (req.query.toDate) filter.orderDate = { ...filter.orderDate, $lte: new Date(req.query.toDate) };
    
    const [orders, total] = await Promise.all([
      SalesOrder.find(filter)
        .sort({ orderDate: -1 })
        .skip(skip)
        .limit(limit),
      SalesOrder.countDocuments(filter)
    ]);
    
    // Get totals
    const totals = await SalesOrder.aggregate([
      { $match: filter },
      { $group: { _id: null, totalAmount: { $sum: "$totalAmount" }, count: { $sum: 1 } } }
    ]);
    
    res.json({
      success: true,
      data: orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      totals: totals[0] || { totalAmount: 0, count: 0 }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// Get sales order by ID
app.get("/api/sales-orders/:id", async (req, res) => {
  try {
    const SalesOrder = (await import("./models/SalesOrder.js")).default;
    
    const order = await SalesOrder.findOne({ internalId: parseInt(req.params.id) });
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: "Sales order not found"
      });
    }
    
    res.json({
      success: true,
      data: order
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// Get sales order statistics
app.get("/api/sales-orders/stats", async (req, res) => {
  try {
    const SalesOrder = (await import("./models/SalesOrder.js")).default;
    
    // Date range
    const fromDate = req.query.fromDate ? new Date(req.query.fromDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last 30 days
    const toDate = req.query.toDate ? new Date(req.query.toDate) : new Date();
    
    // Overall stats
    const overall = await SalesOrder.aggregate([
      { $match: { orderDate: { $gte: fromDate, $lte: toDate } } },
      { 
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalAmount: { $sum: "$totalAmount" },
          avgOrderValue: { $avg: "$totalAmount" },
          totalItems: { $sum: { $size: "$items" } }
        }
      }
    ]);
    
    // By status
    const byStatus = await SalesOrder.aggregate([
      { $match: { orderDate: { $gte: fromDate, $lte: toDate } } },
      { 
        $group: {
          _id: "$orderStatus",
          count: { $sum: 1 },
          totalAmount: { $sum: "$totalAmount" }
        }
      },
      { $sort: { totalAmount: -1 } }
    ]);
    
    // By customer
    const byCustomer = await SalesOrder.aggregate([
      { $match: { orderDate: { $gte: fromDate, $lte: toDate } } },
      { 
        $group: {
          _id: "$customer.customerName",
          count: { $sum: 1 },
          totalAmount: { $sum: "$totalAmount" }
        }
      },
      { $sort: { totalAmount: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({
      success: true,
      dateRange: { fromDate, toDate },
      overall: overall[0] || { totalOrders: 0, totalAmount: 0, avgOrderValue: 0, totalItems: 0 },
      byStatus,
      byCustomer
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// Query item movement data from NetSuite SuiteQL
app.post("/api/inventory/movement", async (req, res) => {
  try {
    let { itemIds, limit } = req.body;
    let ids = [];
    
    // If itemIds are provided, use them
    if (itemIds && Array.isArray(itemIds) && itemIds.length > 0) {
      // Validate that all IDs are numbers
      const invalidIds = itemIds.filter(id => isNaN(parseInt(id)));
      if (invalidIds.length > 0) {
        return res.status(400).json({
          success: false,
          error: "All item IDs must be valid numbers",
          invalidIds,
          timestamp: new Date().toISOString()
        });
      }
      
      // Convert all IDs to integers
      ids = itemIds.map(id => parseInt(id));
    } else {
      // Fetch item IDs from NetSuite inventoryItem endpoint
      console.log("📦 Fetching item IDs from NetSuite inventoryItem endpoint...");
      
      const fetchLimit = limit || 100;
      const inventoryUrl = `${netsuiteConfig.baseUrl}/inventoryItem?limit=${fetchLimit}`;
      
      try {
        const inventoryResponse = await netsuiteRequest({
          method: "GET",
          url: inventoryUrl,
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          timeout: 30000
        });
        
        // Extract IDs from the response
        const items = inventoryResponse.data?.items || [];
        ids = items.map(item => {
          // Try to get ID from different possible fields
          return parseInt(item.id || item.internalId || item.itemId);
        }).filter(id => !isNaN(id));
        
        console.log(`✅ Fetched ${ids.length} item IDs from NetSuite`);
        
        if (ids.length === 0) {
          return res.status(404).json({
            success: false,
            error: "No item IDs found in NetSuite inventory",
            timestamp: new Date().toISOString()
          });
        }
      } catch (fetchError) {
        console.error("Error fetching item IDs from NetSuite:", fetchError);
        return res.status(500).json({
          success: false,
          error: "Failed to fetch item IDs from NetSuite",
          details: fetchError.message,
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // Build the SQL query with item IDs
    const idsString = ids.join(', ');
    const sqlQuery = `SELECT i.id AS item_id, 1 AS moved_last_12_months, MAX(t.trandate) AS last_movement_date FROM item i LEFT JOIN transactionLine tl ON tl.item = i.id LEFT JOIN transaction t ON t.id = tl.transaction AND t.type = 'ItemShip' AND tl.mainline = 'F' WHERE i.id IN (${idsString}) GROUP BY i.id HAVING MAX(t.trandate) >= ADD_MONTHS(TRUNC(SYSDATE), -12)`;
    
    // SuiteQL API endpoint
    const suiteqlUrl = netsuiteConfig.baseUrl.replace('/record/v1', '/query/v1/suiteql');
    
    // Prepare request
    const requestBody = {
      q: sqlQuery
    };
    
    console.log(`📊 Querying movement data for ${ids.length} items...`);
    console.log(`🔍 Item IDs: ${idsString}`);
    
    // Make request to SuiteQL API
    // Note: netsuiteRequest automatically adds Authorization header
    const response = await netsuiteRequest({
      method: "POST",
      url: suiteqlUrl,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Prefer": "transient"  // Required header for SuiteQL API
      },
      data: requestBody,
      timeout: 60000
    });
    
    // Return the results
    res.json({
      success: true,
      // itemIds: ids,
      itemIdsCount: ids.length,
      fetchedFromNetSuite: !req.body.itemIds,
      query: sqlQuery,
      results: response.data?.items || response.data || [],
      count: response.data?.items?.length || 0,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("Error querying item movement:", error);
    
    // Provide more detailed error information
    const errorResponse = {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
    
    if (error.response) {
      errorResponse.status = error.response.status;
      errorResponse.statusText = error.response.statusText;
      errorResponse.data = error.response.data;
    }
    
    res.status(error.response?.status || 500).json(errorResponse);
  }
});

// Helper function to fetch movement data for a batch of item IDs
async function fetchMovementDataForItems(itemIds) {
  try {
    if (!itemIds || itemIds.length === 0) {
      return [];
    }
    
    // Build the SQL query with item IDs - returns all items with their movement status
    // Items that moved in last 12 months will have moved_last_12_months = 1, others = 0
    const idsString = itemIds.join(', ');
    const sqlQuery = `SELECT i.id AS item_id, CASE WHEN MAX(t.trandate) >= ADD_MONTHS(TRUNC(SYSDATE), -12) THEN 1 ELSE 0 END AS moved_last_12_months, MAX(t.trandate) AS last_movement_date FROM item i LEFT JOIN transactionLine tl ON tl.item = i.id LEFT JOIN transaction t ON t.id = tl.transaction AND t.type = 'ItemShip' AND tl.mainline = 'F' WHERE i.id IN (${idsString}) GROUP BY i.id`;
    
    // SuiteQL API endpoint
    const suiteqlUrl = netsuiteConfig.baseUrl.replace('/record/v1', '/query/v1/suiteql');
    
    // Prepare request
    const requestBody = {
      q: sqlQuery
    };
    
    // Make request to SuiteQL API
    const response = await netsuiteRequest({
      method: "POST",
      url: suiteqlUrl,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Prefer": "transient"
      },
      data: requestBody,
      timeout: 60000
    });
    
    return response.data?.items || response.data || [];
  } catch (error) {
    console.error("Error fetching movement data:", error.message);
    throw error;
  }
}

// Helper function to parse date from NetSuite format (DD/MM/YYYY)
function parseNetSuiteDate(dateString) {
  if (!dateString) return null;
  
  try {
    // NetSuite returns dates in DD/MM/YYYY format
    const parts = dateString.split('/');
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
      const year = parseInt(parts[2], 10);
      return new Date(year, month, day);
    }
  } catch (error) {
    console.error(`Error parsing date ${dateString}:`, error.message);
  }
  
  return null;
}

// Update inventory items with movement data (batched)
app.post("/api/inventory/update-movement", async (req, res) => {
  try {
    const { batchSize = 100, maxItems = null } = req.body;
    
    console.log("🔄 Starting movement data update for inventory items...");
    console.log(`📦 Batch size: ${batchSize}, Max items: ${maxItems || 'unlimited'}`);
    
    const InventoryItem = (await import("./models/InventoryItem.js")).default;
    
    // Get total count of items
    const totalCount = await InventoryItem.countDocuments();
    console.log(`📊 Total items in database: ${totalCount}`);
    
    if (totalCount === 0) {
      return res.json({
        success: true,
        message: "No items found in database",
        processed: 0,
        updated: 0,
        timestamp: new Date().toISOString()
      });
    }
    
    let processedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    const errors = [];
    let offset = 0;
    const limit = maxItems ? Math.min(batchSize, maxItems) : batchSize;
    let hasMore = true;
    
    while (hasMore) {
      try {
        // Check if we've reached max items
        if (maxItems && processedCount >= maxItems) {
          break;
        }
        
        // Fetch a batch of items from MongoDB
        const itemsToProcess = maxItems 
          ? Math.min(limit, maxItems - processedCount)
          : limit;
        
        const items = await InventoryItem.find()
          .select('internalId')
          .skip(offset)
          .limit(itemsToProcess)
          .lean();
        
        if (items.length === 0) {
          hasMore = false;
          break;
        }
        
        // Extract internalIds
        const itemIds = items.map(item => item.internalId).filter(id => id != null);
        
        if (itemIds.length === 0) {
          offset += itemsToProcess;
          processedCount += items.length;
          continue;
        }
        
        console.log(`\n📦 Processing batch: ${processedCount + 1} to ${processedCount + items.length} (${itemIds.length} items with IDs)`);
        
        // Fetch movement data for this batch
        const movementData = await fetchMovementDataForItems(itemIds);
        
        // Create a map of item_id to movement data for quick lookup
        const movementMap = new Map();
        movementData.forEach(item => {
          const itemId = parseInt(item.item_id);
          if (!isNaN(itemId)) {
            const moved = item.moved_last_12_months === "1" || item.moved_last_12_months === 1 || item.moved_last_12_months === true;
            const lastMovementDate = item.last_movement_date 
              ? parseNetSuiteDate(item.last_movement_date)
              : null;
            
            movementMap.set(itemId, {
              last_movement_date: moved ? lastMovementDate : null,
              moved_last_12_months: moved
            });
          }
        });
        
        // Update items in batch
        const updatePromises = itemIds.map(async (itemId) => {
          try {
            const movement = movementMap.get(itemId);
            
            if (movement) {
              // Item has movement data - update it
              await InventoryItem.updateOne(
                { internalId: itemId },
                {
                  $set: {
                    last_movement_date: movement.last_movement_date,
                    moved_last_12_months: movement.moved_last_12_months
                  }
                }
              );
              if (movement.moved_last_12_months) {
                updatedCount++;
              }
            } else {
              // Item not in movement results - no transactions, set to null/false
              await InventoryItem.updateOne(
                { internalId: itemId },
                {
                  $set: {
                    last_movement_date: null,
                    moved_last_12_months: false
                  }
                }
              );
            }
          } catch (updateError) {
            errorCount++;
            errors.push({ itemId, error: updateError.message });
            console.error(`❌ Error updating item ${itemId}:`, updateError.message);
          }
        });
        
        await Promise.all(updatePromises);
        
        processedCount += items.length;
        offset += items.length;
        
        console.log(`✅ Batch complete: Updated ${movementData.length} items with movement data`);
        
        // Add delay between batches to avoid rate limiting
        if (hasMore && items.length === itemsToProcess) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Check if we should continue
        hasMore = items.length === itemsToProcess && (!maxItems || processedCount < maxItems);
        
      } catch (batchError) {
        console.error(`❌ Error processing batch at offset ${offset}:`, batchError.message);
        errorCount++;
        errors.push({ batch: offset, error: batchError.message });
        // Continue with next batch
        offset += limit;
        if (offset >= totalCount) {
          hasMore = false;
        }
      }
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("📦 MOVEMENT DATA UPDATE COMPLETE");
    console.log("=".repeat(60));
    console.log(`📊 Processed: ${processedCount} items`);
    console.log(`✅ Updated with movement data: ${updatedCount} items`);
    console.log(`❌ Errors: ${errorCount} items`);
    
    res.json({
      success: true,
      processed: processedCount,
      updated: updatedCount,
      errors: errorCount,
      errorDetails: errors.length > 0 ? errors.slice(0, 50) : undefined,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("Error updating movement data:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ 
    success: false,
    error: "Internal server error",
    message: err.message,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false,
    error: "Route not found",
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 API available at http://localhost:${PORT}`);
  console.log(`📝 Test authentication: http://localhost:${PORT}/api/test-auth`);
});