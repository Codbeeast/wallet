import mongoose, { Schema, Document } from 'mongoose';

export interface ISystemConfigBEP20 extends Document {
  key: string;
  platformBalance: number; // Stored in USDT (e.g. 10240.50)
  lowFundsThreshold: number; // Stored in USDT (e.g. 15000.00)
  warmWalletAddress: string; // EVM 0x address
  usdtContractAddress: string; // BEP-20 USDT contract 0x address
  coldTreasuryAddress: string; // EVM 0x address
  lastUpdated?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SystemConfigBEP20Schema: Schema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'bsc_platform_config',
    },
    platformBalance: {
      type: Number,
      required: true,
      default: 10240.50,
    },
    lowFundsThreshold: {
      type: Number,
      required: true,
      default: 15000.00,
    },
    warmWalletAddress: {
      type: String,
      required: true,
      trim: true,
    },
    usdtContractAddress: {
      type: String,
      required: true,
      trim: true,
    },
    coldTreasuryAddress: {
      type: String,
      required: true,
      trim: true,
    },
    lastUpdated: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Pre-save to ensure key is always 'bsc_platform_config'
SystemConfigBEP20Schema.pre('save', function (this: any) {
  this.set('key', 'bsc_platform_config');
});

export default mongoose.models.SystemConfigBEP20 ||
  mongoose.model<ISystemConfigBEP20>('SystemConfigBEP20', SystemConfigBEP20Schema);
