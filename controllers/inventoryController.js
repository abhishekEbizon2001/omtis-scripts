import InventoryItem from "../models/InventoryItem.js";
import netsuiteService from "../services/netsuiteService.js";

// Helper function to map NetSuite response to meaningful field names
const mapNetSuiteToMongoose = (itemDetail) => {

    const price = itemDetail.priceData?.price || 0;
  const currency = itemDetail.priceData?.currency || "HKD";
  return {
    internalId: itemDetail.internalId,
    
        // Price Information
        price: price,
    currency: currency,
    

    // Map custitem_wineid to omtisWineId
    omtisWineId: itemDetail.custitem_wineid || null,
    
    // Map unitsType to unitType
    unitType: itemDetail.unitsType ? {
      id: itemDetail.unitsType.id,
      name: itemDetail.unitsType.refName,
    } : null,
    
    // Map itemId to itemName
    itemName: itemDetail.itemId,
    
    // Map custitem86 to replenishmentId
    replenishmentId: itemDetail.custitem86 || null,
    
    // Purchase description
    purchaseDescription: itemDetail.purchaseDescription || null,
    
    // Map custitem_product_desc to productDescription
    productDescription: itemDetail.custitem_product_desc || null,
    
    // Map custitem_inventory_category to inventoryCategory
    inventoryCategory: itemDetail.custitem_inventory_category ? {
      id: itemDetail.custitem_inventory_category.id,
      name: itemDetail.custitem_inventory_category.refName,
    } : null,
    
    // Map custitem_inventory_subcategory to inventorySubcategory
    inventorySubcategory: itemDetail.custitem_inventory_subcategory ? {
      id: itemDetail.custitem_inventory_subcategory.id,
      name: itemDetail.custitem_inventory_subcategory.refName,
    } : null,
    
    // Map custitem20 to omtisWineCategory
    omtisWineCategory: itemDetail.custitem20 ? {
      id: itemDetail.custitem20.id,
      name: itemDetail.custitem20.refName,
    } : null,
    
    // Map custitem15 to producer
    producer: itemDetail.custitem15 ? {
      id: itemDetail.custitem15.id,
      name: itemDetail.custitem15.refName,
    } : null,
    
    // Map custitemliveexwinename to omtisNameDetail
    omtisNameDetail: itemDetail.custitemliveexwinename || null,
    
    // Map custitem26 to omtisName
    omtisName: itemDetail.custitem26 ? {
      id: itemDetail.custitem26.id,
      name: itemDetail.custitem26.refName,
    } : null,
    
    // Map custitem_classification to wineClassification
    wineClassification: itemDetail.custitem_classification ? {
      id: itemDetail.custitem_classification.id,
      name: itemDetail.custitem_classification.refName,
    } : null,
    
    // Map custitem3 to vintage
    vintage: itemDetail.custitem3 || null,
    
    // Map custitem_wine_appellation to appellation
    appellation: itemDetail.custitem_wine_appellation ? {
      id: itemDetail.custitem_wine_appellation.id,
      name: itemDetail.custitem_wine_appellation.refName,
    } : null,
    
    // Map custitem19 to bottleSize
    bottleSize: itemDetail.custitem19 ? {
      id: itemDetail.custitem19.id,
      name: itemDetail.custitem19.refName,
    } : null,
    
    // Map custitem_sub_region to subRegion
    subRegion: itemDetail.custitem_sub_region ? {
      id: itemDetail.custitem_sub_region.id,
      name: itemDetail.custitem_sub_region.refName,
    } : null,
    
    // Weight
    weight: itemDetail.weight || null,
    
    // Map weightUnit
    weightUnit: itemDetail.weightUnit ? {
      id: itemDetail.weightUnit.id,
      name: itemDetail.weightUnit.refName,
    } : null,
    
    // Map custitem_region to region
    region: itemDetail.custitem_region ? {
      id: itemDetail.custitem_region.id,
      name: itemDetail.custitem_region.refName,
    } : null,
    
    // Map custitem9 to country
    country: itemDetail.custitem9 ? {
      id: itemDetail.custitem9.id,
      name: itemDetail.custitem9.refName,
    } : null,
    
    // Map custitem_type to wineType
    wineType: itemDetail.custitem_type ? {
      id: itemDetail.custitem_type.id,
      name: itemDetail.custitem_type.refName,
    } : null,
  };
};

// Sync inventory items from NetSuite

export const syncInventoryItems = async (req, res) => {
  try {
    const { limit = 10, batchSize = 5 } = req.query;
    
    console.log("🔄 Starting NetSuite inventory sync with price...");
    console.log(`📊 Limit: ${limit} items, Batch size: ${batchSize}`);
    
    // Step 1: Get all inventory item IDs
    const itemsListResponse = await netsuiteService.getAllInventoryItems();
    const itemIds = itemsListResponse.items.map(item => item.id);
    
    console.log(`📦 Found ${itemIds.length} total items in NetSuite`);
    console.log(`🎯 Syncing first ${limit} items with price information...`);
    
    // Step 2: Fetch detailed data WITH PRICE using batch processing
    const itemsToSync = itemIds.slice(0, parseInt(limit));
    const { results, errors } = await netsuiteService.batchGetItemsWithPrice(
      itemsToSync, 
      parseInt(batchSize)
    );
    
    console.log(`✅ Successfully fetched ${results.length} item details with price`);
    
    // Log price summary
    const itemsWithPrice = results.filter(item => item.priceData?.price > 0);
    const itemsWithLPCP = results.filter(item => 
      item.priceData?.price > 0 && item.priceData?.currency === "HKD"
    );
    const itemsWithEP = results.filter(item => 
      item.priceData?.price > 0 && item.priceData?.currency === "EUR"
    );
    
    console.log(`💰 Price Summary:`);
    console.log(`   Items with price: ${itemsWithPrice.length}/${results.length}`);
    console.log(`   Items with LPCP (HKD): ${itemsWithLPCP.length}`);
    console.log(`   Items with EP Price (EUR): ${itemsWithEP.length}`);
    
    if (itemsWithPrice.length > 0) {
      const totalPrice = itemsWithPrice.reduce((sum, item) => sum + (item.priceData?.price || 0), 0);
      const avgPrice = totalPrice / itemsWithPrice.length;
      console.log(`   Average price: ${avgPrice.toFixed(2)}`);
    }
    
    // Step 3: Save to MongoDB
    const syncedItems = [];
    
    for (const itemDetail of results) {
      try {
        const mappedItem = mapNetSuiteToMongoose(itemDetail);
        
        const savedItem = await InventoryItem.findOneAndUpdate(
          { internalId: mappedItem.internalId },
          mappedItem,
          { upsert: true, new: true }
        );
        
        syncedItems.push(savedItem);
        
        // Log price info for this item
        const priceInfo = itemDetail.priceData?.price > 0 
          ? `💰 Price: ${itemDetail.priceData.price} ${itemDetail.priceData.currency}` 
          : `💰 No price found`;
        
        console.log(`💾 Saved: ${itemDetail.itemId} (ID: ${itemDetail.internalId}) - ${priceInfo}`);
        
      } catch (error) {
        console.error(`❌ Failed to save item ${itemDetail.internalId}:`, error.message);
        errors.push({ 
          itemId: itemDetail.internalId, 
          error: error.message 
        });
      }
    }
    
    console.log(`🎉 Sync completed! ${syncedItems.length} items synced successfully`);
    
    res.status(200).json({
      success: true,
      message: `Successfully synced ${syncedItems.length} of ${itemsToSync.length} items with price`,
      data: {
        totalAvailable: itemIds.length,
        requested: itemsToSync.length,
        synced: syncedItems.length,
        failed: errors.length,
        priceStats: {
          itemsWithPrice: itemsWithPrice.length,
          itemsWithLPCP: itemsWithLPCP.length,
          itemsWithEP: itemsWithEP.length,
        }
      },
      items: syncedItems,
      errors: errors.length > 0 ? errors : undefined,
    });
    
  } catch (error) {
    console.error("❌ Sync error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to sync inventory items",
      error: error.message,
    });
  }
};

// Get all inventory items from MongoDB
export const getAllItems = async (req, res) => {
  try {
    const { page = 1, limit = 50, sort = '-createdAt' } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const items = await InventoryItem
      .find()
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await InventoryItem.countDocuments();
    
    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalItems: total,
          itemsPerPage: parseInt(limit),
        }
      }
    });
  } catch (error) {
    console.error("❌ Error fetching items:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch items",
      error: error.message,
    });
  }
};

// Get single item by internal ID
export const getItemById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const item = await InventoryItem.findOne({ internalId: id });
    
    if (!item) {
      return res.status(404).json({
        success: false,
        message: `Item with ID ${id} not found`,
      });
    }
    
    res.status(200).json({
      success: true,
      data: item,
    });
  } catch (error) {
    console.error("❌ Error fetching item:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch item",
      error: error.message,
    });
  }
};

// Get items by filters
export const getItemsByFilter = async (req, res) => {
  try {
    const { 
      country, 
      vintage, 
      wineType, 
      region, 
      producer,
      page = 1,
      limit = 50 
    } = req.query;
    
    const filter = {};
    
    if (country) filter["country.name"] = new RegExp(country, "i");
    if (vintage) filter.vintage = vintage;
    if (wineType) filter["wineType.name"] = new RegExp(wineType, "i");
    if (region) filter["region.name"] = new RegExp(region, "i");
    if (producer) filter["producer.name"] = new RegExp(producer, "i");
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const items = await InventoryItem
      .find(filter)
      .sort({ vintage: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await InventoryItem.countDocuments(filter);
    
    res.status(200).json({
      success: true,
      filters: { country, vintage, wineType, region, producer },
      data: {
        items,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalItems: total,
          itemsPerPage: parseInt(limit),
        }
      }
    });
  } catch (error) {
    console.error("❌ Error filtering items:", error);
    res.status(500).json({
      success: false,
      message: "Failed to filter items",
      error: error.message,
    });
  }
};

// Get inventory statistics
export const getStatistics = async (req, res) => {
  try {
    const stats = await InventoryItem.getStatistics();
    
    // Get top producers
    const topProducers = await InventoryItem.aggregate([
      { $match: { "producer.name": { $exists: true, $ne: null } } },
      { $group: { _id: "$producer.name", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, producer: "$_id", count: 1 } }
    ]);
    
    // Get items by wine type
    const byWineType = await InventoryItem.aggregate([
      { $match: { "wineType.name": { $exists: true, $ne: null } } },
      { $group: { _id: "$wineType.name", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, type: "$_id", count: 1 } }
    ]);
    
    // Get items by country
    const byCountry = await InventoryItem.aggregate([
      { $match: { "country.name": { $exists: true, $ne: null } } },
      { $group: { _id: "$country.name", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, country: "$_id", count: 1 } }
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        overview: stats,
        topProducers,
        byWineType,
        byCountry,
      }
    });
  } catch (error) {
    console.error("❌ Error fetching statistics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch statistics",
      error: error.message,
    });
  }
};

// Search items by text
export const searchItems = async (req, res) => {
  try {
    const { q, page = 1, limit = 50 } = req.query;
    
    if (!q) {
      return res.status(400).json({
        success: false,
        message: "Search query 'q' is required",
      });
    }
    
    const searchRegex = new RegExp(q, "i");
    
    const filter = {
      $or: [
        { itemName: searchRegex },
        { omtisNameDetail: searchRegex },
        { "producer.name": searchRegex },
        { vintage: searchRegex },
      ]
    };
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const items = await InventoryItem
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await InventoryItem.countDocuments(filter);
    
    res.status(200).json({
      success: true,
      searchQuery: q,
      data: {
        items,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalItems: total,
          itemsPerPage: parseInt(limit),
        }
      }
    });
  } catch (error) {
    console.error("❌ Error searching items:", error);
    res.status(500).json({
      success: false,
      message: "Failed to search items",
      error: error.message,
    });
  }
};
