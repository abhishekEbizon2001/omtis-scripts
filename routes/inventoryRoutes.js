import express from "express";
import { 
  syncInventoryItems, 
  getAllItems,
  getItemById,
  getItemsByFilter,
  getStatistics,
  searchItems
} from "../controllers/inventoryController.js";

const router = express.Router();

// Sync inventory from NetSuite
// POST /api/inventory/sync?limit=10&batchSize=5
router.post("/sync", syncInventoryItems);

// Get statistics
// GET /api/inventory/statistics
router.get("/statistics", getStatistics);

// Search items
// GET /api/inventory/search?q=belair&page=1&limit=20
router.get("/search", searchItems);

// Get items by filters
// GET /api/inventory/filter?country=France&vintage=2014&wineType=Red
router.get("/filter", getItemsByFilter);

// Get all items with pagination
// GET /api/inventory?page=1&limit=50&sort=-createdAt
router.get("/", getAllItems);

// Get single item by internal ID
// GET /api/inventory/:id
router.get("/:id", getItemById);

export default router;
