import { Schema, model, Document } from "mongoose";

export interface IDonation extends Document {
  campaignId: number;
  donor:      string;
  amount:     string;  // wei as string
  txHash:     string;
  blockNumber: number;
  timestamp:  Date;
  tokenType: number;
  status: string;
}

const DonationSchema = new Schema<IDonation>({
  campaignId:  { type: Number, required: true, index: true },
  donor:       { type: String, required: true, index: true },
  amount:      { type: String, required: true },
  txHash:      { type: String, required: true, unique: true },
  blockNumber: { type: Number, default: 0 },
  timestamp:   { type: Date,   default: Date.now },
  tokenType:   { type: Number, default: 0}, // 0 = ETH, 1 = USDC
  status:      { type: String, default: "locked", enum: ["locked", "released", "refunded"] },   
});

export const Donation = model<IDonation>("Donation", DonationSchema);
