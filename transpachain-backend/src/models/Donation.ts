import { Schema, model, Document } from "mongoose";

export interface IDonation extends Document {
  campaignId: number;
  donor:      string;
  amount:     string;  // wei as string
  txHash:     string;
  blockNumber: number;
  timestamp:  Date;
}

const DonationSchema = new Schema<IDonation>({
  campaignId:  { type: Number, required: true, index: true },
  donor:       { type: String, required: true, index: true },
  amount:      { type: String, required: true },
  txHash:      { type: String, required: true, unique: true },
  blockNumber: { type: Number, required: true },
  timestamp:   { type: Date,   default: Date.now },
});

export const Donation = model<IDonation>("Donation", DonationSchema);
