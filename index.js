import express from "express";
import dotenv from "dotenv";
import { connectDB } from "./config/db.js";
import { syncInventory, testAuthentication } from "./scripts/syncInventory.js";
import { syncSalesOrders } from "./scripts/syncSalesOrders.js";

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