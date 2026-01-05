import mongoose from "mongoose";

const salesOrderItemSchema = new mongoose.Schema({
  // Basic Item Information
  itemId: {
    type: String,
    default: ""
  },
  itemName: {
    type: String,
    default: ""
  },
  salesDescription: {
    type: String,
    default: ""
  },
  omtisId: {
    type: String,
    default: ""
  },
  
  // NEW: Item Details from Inventory Item
  producer: {
    type: String,
    default: ""
  },
  region: {
    type: String,
    default: ""
  },
  
  // Quantity Information
  quantity: {
    type: Number,
    default: 0
  },
  units: {
    type: String,
    default: ""
  },
  fulfilled: {
    type: Number,
    default: 0
  },
  invoiced: {
    type: Number,
    default: 0
  },
  available: {
    type: Number,
    default: 0
  },
  
  // Pricing Information
  priceLevel: {
    type: String,
    default: ""
  },
  unitPrice: {
    type: Number,
    default: 0.0
  },
  total: {
    type: Number,
    default: 0.0
  },
  grossProfit: {
    type: Number,
    default: 0.0
  },
  
  // Metadata
  line: {
    type: Number,
    default: 0
  },
  isClosed: {
    type: Boolean,
    default: false
  },
  isOpen: {
    type: Boolean,
    default: false
  }
});

const salesOrderSchema = new mongoose.Schema({
  // Basic Information
  internalId: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  transactionNumber: {
    type: String,
    default: "",
    index: true
  },
  
  // Customer Information (extracted from entity field)
  customer: {
    customerId: {
      type: String,
      default: ""
    },
    customerName: {
      type: String,
      default: ""
    },
    email: {
      type: String,
      default: ""
    }
  },
  
  // Order Information
  orderDate: {
    type: Date,
    default: null
  },
  deliveryDate: {
    type: Date,
    default: null
  },
  
  // Company Information
  subsidiary: {
    id: {
      type: String,
      default: ""
    },
    name: {
      type: String,
      default: ""
    }
  },
  department: {
    id: {
      type: String,
      default: ""
    },
    name: {
      type: String,
      default: ""
    }
  },
  location: {
    id: {
      type: String,
      default: ""
    },
    name: {
      type: String,
      default: ""
    }
  },
  
  // Financial Information
  currency: {
    id: {
      type: String,
      default: ""
    },
    name: {
      type: String,
      default: ""
    }
  },
  terms: {
    id: {
      type: String,
      default: ""
    },
    name: {
      type: String,
      default: ""
    }
  },
  invoiceNumber: {
    type: String,
    default: ""
  },
  
  // Customer Financial Information
  customerBalance: {
    type: Number,
    default: 0.0
  },
  customerBalanceGroup: {
    type: Number,
    default: 0.0
  },
  creditLimit: {
    type: Number,
    default: 0.0
  },
  consolidatedOverdueBalance: {
    type: Number,
    default: 0.0
  },
  consolidatedDaysOverdue: {
    type: Number,
    default: 0
  },
  
  // Order Status
  holdType: {
    id: {
      type: String,
      default: ""
    },
    name: {
      type: String,
      default: ""
    }
  },
  holdExtensionDate: {
    type: Date,
    default: null
  },
  
  // Shipping Information
  shipTo: {
    type: String,
    default: ""
  },
  shipContact: {
    type: String,
    default: ""
  },
  
  // Sales Information
  salesRep: {
    id: {
      type: String,
      default: ""
    },
    name: {
      type: String,
      default: ""
    }
  },
  
  // Order Items
  items: [salesOrderItemSchema],
  
  // Totals
  subtotal: {
    type: Number,
    default: 0.0
  },
  discountTotal: {
    type: Number,
    default: 0.0
  },
  totalAmount: {
    type: Number,
    default: 0.0
  },
  estGrossProfit: {
    type: Number,
    default: 0.0
  },
  estGrossProfitPercent: {
    type: Number,
    default: 0.0
  },
  
  // Status
  orderStatus: {
    type: String,
    default: ""
  },
  
  // Dates
  createdDate: {
    type: Date,
    default: null
  },
  lastModifiedDate: {
    type: Date,
    default: null
  },
  tranDate: {
    type: Date,
    default: null
  },
  shipDate: {
    type: Date,
    default: null
  },
  salesEffectiveDate: {
    type: Date,
    default: null
  },
  
  // Raw data for debugging
  // rawData: {
  //   type: String,
  //   default: ""
  // },
  
  // Metadata
  lastSynced: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for better query performance
salesOrderSchema.index({ 'customer.customerName': 1 });
salesOrderSchema.index({ orderDate: -1 });
salesOrderSchema.index({ totalAmount: -1 });
salesOrderSchema.index({ orderStatus: 1 });
salesOrderSchema.index({ 'salesRep.name': 1 });
salesOrderSchema.index({ 'items.omtisId': 1 });
salesOrderItemSchema.index({ producer: 1 });
salesOrderItemSchema.index({ region: 1 });
salesOrderItemSchema.index({ producer: 1, region: 1 });

export default mongoose.model("SalesOrder", salesOrderSchema);