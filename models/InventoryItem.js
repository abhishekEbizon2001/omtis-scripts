// models/inventoryItem.js - Updated schema
import mongoose from "mongoose";

const inventoryItemSchema = new mongoose.Schema({
  // Basic Information
  internalId: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  itemName: {
    type: String,
    default: "",
    index: true
  },
  
  // Omtis Information
  omtisId: {
    type: String,
    default: ""
  },
  omtisWineCategory: {
    type: String,
    default: ""
  },
  omtisNameDetail: {
    type: String,
    default: ""
  },
  omtisName: {
    type: String,
    default: ""
  },
  
  // Product Information
  unitType: {
    type: String,
    default: ""
  },
  purchaseDescription: {
    type: String,
    default: ""
  },
  productDescription: {
    type: String,
    default: ""
  },
  replenishmentId: {
    type: String,
    default: ""
  },
  
  // Inventory Classification
  inventoryCategory: {
    type: String,
    default: ""
  },
  inventorySubcategory: {
    type: String,
    default: ""
  },
  classification: {
    type: String,
    default: ""
  },
  
  // Wine Details
  producer: {
    type: String,
    default: ""
  },
  vintage: {
    type: String,
    default: ""
  },
  type: {
    type: String,
    default: ""
  },
  bottleSize: {
    type: String,
    default: ""
  },
  
  // Geographic Information
  country: {
    type: String,
    default: ""
  },
  region: {
    type: String,
    default: ""
  },
  subRegion: {
    type: String,
    default: ""
  },
  appellation: {
    type: String,
    default: ""
  },
  
  // Weight Information
  itemWeight: {
    type: Number,
    default: 0
  },
  weightUnit: {
    type: String,
    default: ""
  },
  
  // Pricing Information
  price: {
    type: Number,
    default: 0.0
  },
  currency: {
    type: String,
    default: "HKD",  // Default currency
    enum: ["HKD", "EUR", "USD"]  // Add other currencies as needed
  },
  
  // New pricing field with trade and retail prices
  pricing: {
    tradePrice: {
      type: Number,
      default: 0.0
    },
    retailPrice: {
      type: Number,
      default: 0.0
    }
  },
  
  // Financial Information
  averageCost: {
    type: Number,
    default: 0.0
  },
  totalValue: {
    type: Number,
    default: 0.0
  },
  
  // Inventory Locations
  locations: [{
    locationId: {
      type: Number,
      required: true
    },
    location: {
      type: String,
      default: ""
    },
    address: {
      type: String,
      default: ""
    },
    city: {
      type: String,
      default: ""
    },
    country: {
      type: String,
      default: ""
    },
    zip: {
      type: String,
      default: ""
    },
    quantityOnHand: {
      type: Number,
      default: 0
    },
    quantityAvailable: {
      type: Number,
      default: 0
    }
  }],
  
  // Total Quantity (sum of quantityAvailable from all locations)
  totalQuantity: {
    type: Number,
    default: 0,
    index: true
  },
  
  // Raw data for debugging
  rawData: {
    type: String,
    default: ""
  },
  
  // Metadata
  lastSynced: {
    type: Date,
    default: Date.now,
    index: true
  },
  createdDate: {
    type: Date,
    default: null
  },
  lastModifiedDate: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Index for better query performance
inventoryItemSchema.index({ omtisId: 1 });
inventoryItemSchema.index({ vintage: 1, type: 1 });
inventoryItemSchema.index({ country: 1, region: 1 });
inventoryItemSchema.index({ averageCost: 1 });
inventoryItemSchema.index({ totalValue: 1 });
inventoryItemSchema.index({ totalQuantity: 1 });
inventoryItemSchema.index({ 'locations.locationId': 1 });

// Virtual for formatted weight display
inventoryItemSchema.virtual('formattedWeight').get(function() {
  if (this.itemWeight && this.weightUnit) {
    return `${this.itemWeight} ${this.weightUnit}`;
  }
  return '';
});

// Virtual for wine display name
inventoryItemSchema.virtual('displayName').get(function() {
  const parts = [];
  if (this.producer) parts.push(this.producer);
  if (this.itemName) parts.push(this.itemName);
  if (this.vintage) parts.push(`(${this.vintage})`);
  if (this.bottleSize) parts.push(`[${this.bottleSize}]`);
  return parts.join(' ');
});

// Pre-save middleware to calculate totalQuantity
inventoryItemSchema.pre('save', function(next) {
  if (this.locations && Array.isArray(this.locations)) {
    this.totalQuantity = this.locations.reduce((total, location) => {
      return total + (location.quantityAvailable || 0);
    }, 0);
  } else {
    this.totalQuantity = 0;
  }
  next();
});

export default mongoose.model("InventoryItem", inventoryItemSchema);