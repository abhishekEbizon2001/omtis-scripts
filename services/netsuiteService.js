import axios from "axios";
import OAuth from "oauth-1.0a";
import CryptoJS from "crypto-js";
import querystring from "querystring";

class NetSuiteService {
  constructor() {
    this.accountId = process.env.NETSUITE_ACCOUNT_ID;
    this.consumerKey = process.env.NETSUITE_CONSUMER_KEY;
    this.consumerSecret = process.env.NETSUITE_CONSUMER_SECRET;
    this.tokenKey = process.env.NETSUITE_TOKEN_KEY;
    this.tokenSecret = process.env.NETSUITE_TOKEN_SECRET;
    this.restApiUrl = process.env.NETSUITE_REST_API_URL;

    // Initialize OAuth 1.0a
    this.oauth = OAuth({
      consumer: {
        key: this.consumerKey,
        secret: this.consumerSecret,
      },
      signature_method: "HMAC-SHA256",
      realm: this.accountId,
      hash_function(base_string, key) {
        return CryptoJS.HmacSHA256(base_string, key).toString(CryptoJS.enc.Base64);
      },
    });

    this.token = {
      key: this.tokenKey,
      secret: this.tokenSecret,
    };
  }

  // Generate OAuth headers for request
  generateHeaders(url, method = "GET") {
    const request_data = { url, method };
    const headers = this.oauth.toHeader(this.oauth.authorize(request_data, this.token));
    headers["Content-Type"] = "application/json";
    headers["Accept"] = "application/json";
    return headers;
  }

  // Encode query string properly
  encodeQueryString(params) {
    return querystring.stringify(params)
      .replace(/\!/g, "%21")
      .replace(/\'/g, "%27")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\*/g, "%2A");
  }

  // Get all inventory items with pagination support
  async getAllInventoryItems(query = 'lastModifiedDate AFTER "10/04/2024"', limit = 1000, offset = 0) {
    const baseUrl = `${this.restApiUrl}/services/rest/record/v1/inventoryItem`;
    const queryParams = { q: query, limit, offset };
    
    const encodedQueryString = this.encodeQueryString(queryParams);
    const fullUrl = `${baseUrl}?${encodedQueryString}`;
    const headers = this.generateHeaders(fullUrl, "GET");

    try {
      const response = await axios({
        url: fullUrl,
        method: "GET",
        headers,
        timeout: 30000, // 30 seconds timeout
      });
      console.log("data->", response.data)
      return response.data;
    } catch (error) {
      console.error("❌ Error fetching inventory items:", error.response?.data || error.message);
      throw new Error(`Failed to fetch inventory items: ${error.message}`);
    }
  }

  // Get inventory item by ID
  async getInventoryItemById(itemId) {
    const url = `${this.restApiUrl}/services/rest/record/v1/inventoryitem/${itemId}`;
    const headers = this.generateHeaders(url, "GET");

    try {
      const response = await axios({
        url,
        method: "GET",
        headers,
        timeout: 30000,
      });
      
      return response.data;
    } catch (error) {
      console.error(`❌ Error fetching item ${itemId}:`, error.response?.data || error.message);
      throw new Error(`Failed to fetch item ${itemId}: ${error.message}`);
    }
  }

  // Fetch all items with automatic pagination handling
  async fetchAllItemsWithPagination(query = 'lastModifiedDate AFTER "10/04/2024"') {
    let allItems = [];
    let hasMore = true;
    let offset = 0;
    const limit = 1000;

    console.log("🔄 Starting pagination fetch...");

    while (hasMore) {
      try {
        const data = await this.getAllInventoryItems(query, limit, offset);
        
        allItems = allItems.concat(data.items);
        hasMore = data.hasMore;
        offset += limit;
        
        console.log(`✅ Fetched ${allItems.length} of ${data.totalResults} items`);
        
        // Add a small delay to avoid rate limiting
        if (hasMore) {
          await this.delay(100);
        }
      } catch (error) {
        console.error("❌ Error in pagination:", error.message);
        hasMore = false;
      }
    }

    console.log(`🎉 Pagination complete. Total items fetched: ${allItems.length}`);
    return allItems;
  }

  // Get price information for an item
  async getItemPrices(itemId) {
    const priceUrl = `${this.restApiUrl}/services/rest/record/v1/inventoryitem/${itemId}/price`;
    const headers = this.generateHeaders(priceUrl, "GET");

    try {
      const response = await axios({
        url: priceUrl,
        method: "GET",
        headers,
        timeout: 30000,
      });
      
      return response.data;
    } catch (error) {
      console.error(`❌ Error fetching prices for item ${itemId}:`, error.response?.data || error.message);
      return null;
    }
  }

  // Get price details from specific price URL
  async getPriceDetails(priceUrl) {
    const headers = this.generateHeaders(priceUrl, "GET");

    try {
      const response = await axios({
        url: priceUrl,
        method: "GET",
        headers,
        timeout: 30000,
      });
      
      return response.data;
    } catch (error) {
      console.error(`❌ Error fetching price details from ${priceUrl}:`, error.message);
      return null;
    }
  }

   // Extract price and currency from item prices
  async extractPriceAndCurrency(itemId) {
    try {
      const priceData = await this.getItemPrices(itemId);
      
      if (!priceData || !priceData.items || priceData.items.length === 0) {
        return { price: 0, currency: "HKD" };
      }

      let finalPrice = 0;
      let finalCurrency = "HKD";
      let hasPrice = false;

      // Fetch price details for each price item
      for (const priceItem of priceData.items) {
        if (priceItem.links && priceItem.links[0] && priceItem.links[0].href) {
          const priceDetail = await this.getPriceDetails(priceItem.links[0].href);
          
          if (priceDetail && priceDetail.priceLevelName) {
            // Check if this is one of the price levels we're interested in
            if (priceDetail.priceLevelName === "LPCP (HKD)") {
              finalPrice = priceDetail.price || 0;
              finalCurrency = "HKD";
              hasPrice = true;
              console.log(`💰 Found LPCP price for item ${itemId}: ${finalPrice} ${finalCurrency}`);
              break; // Found our primary price, stop looking
            } 
            else if (priceDetail.priceLevelName === "EP Price (EUR)") {
              // Only use EP Price if we haven't found LPCP yet
              if (!hasPrice) {
                finalPrice = priceDetail.price || 0;
                finalCurrency = "EUR";
                hasPrice = true;
                console.log(`💰 Found EP Price for item ${itemId}: ${finalPrice} ${finalCurrency}`);
                // Don't break, keep looking for LPCP which has priority
              }
            }
          }
        }
      }

      // If we didn't find either price level, use the first available price
      if (!hasPrice && priceData.items.length > 0) {
        const firstPriceItem = priceData.items[0];
        if (firstPriceItem.links && firstPriceItem.links[0] && firstPriceItem.links[0].href) {
          const priceDetail = await this.getPriceDetails(firstPriceItem.links[0].href);
          if (priceDetail && priceDetail.price) {
            finalPrice = priceDetail.price;
            console.log(`💰 Using first available price for item ${itemId}: ${finalPrice}`);
          }
        }
      }

      return { 
        price: finalPrice, 
        currency: finalCurrency 
      };
    } catch (error) {
      console.error(`❌ Error extracting price for item ${itemId}:`, error.message);
      return { price: 0, currency: "HKD" };
    }
  }


    // Enhanced get inventory item by ID with price
  async getInventoryItemByIdWithPrice(itemId) {
    try {
      // Get basic item data
      const itemData = await this.getInventoryItemById(itemId);
      
      if (!itemData) {
        throw new Error(`Failed to fetch item ${itemId}`);
      }

      // Get price data
      const { price, currency } = await this.extractPriceAndCurrency(itemId);
      
      // Add price and currency to item data
      return {
        ...itemData,
        priceData: {
          price,
          currency
        }
      };
    } catch (error) {
      console.error(`❌ Error fetching item ${itemId} with price:`, error.message);
      throw error;
    }
  }

  // Batch get items with price information
  async batchGetItemsWithPrice(itemIds, batchSize = 5) {
    const results = [];
    const errors = [];

    for (let i = 0; i < itemIds.length; i += batchSize) {
      const batch = itemIds.slice(i, i + batchSize);
      
      console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(itemIds.length / batchSize)}`);
      
      const batchPromises = batch.map(async (itemId) => {
        try {
          const item = await this.getInventoryItemByIdWithPrice(itemId);
          return { success: true, data: item };
        } catch (error) {
          return { success: false, itemId, error: error.message };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.success) {
          results.push(result.data);
        } else {
          errors.push({ itemId: result.itemId, error: result.error });
        }
      });

      // Delay between batches to respect rate limits
      if (i + batchSize < itemIds.length) {
        await this.delay(500); // Increased delay for price calls
      }
    }

    return { results, errors };
  }


  // Utility: Delay function
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Batch get items by IDs with rate limiting
  async batchGetItems(itemIds, batchSize = 5) {
    const results = [];
    const errors = [];

    for (let i = 0; i < itemIds.length; i += batchSize) {
      const batch = itemIds.slice(i, i + batchSize);
      
      console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(itemIds.length / batchSize)}`);
      
      const batchPromises = batch.map(async (itemId) => {
        try {
          const item = await this.getInventoryItemById(itemId);
          return { success: true, data: item };
        } catch (error) {
          return { success: false, itemId, error: error.message };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.success) {
          results.push(result.data);
        } else {
          errors.push({ itemId: result.itemId, error: result.error });
        }
      });

      // Delay between batches to respect rate limits
      if (i + batchSize < itemIds.length) {
        await this.delay(200);
      }
    }

    return { results, errors };
  }
}

export default new NetSuiteService();
