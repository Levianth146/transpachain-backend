import { Schema, model, Document } from "mongoose";

export interface ICampaign extends Document {
  campaignId:   number;
  orgAddress:   string;
  metadataCID:  string;
  title:        string;
  description:  string;
  category:     string;
  imageUrl:     string;
  orgName:      string;
  goalAmount:   string;   // wei as string (avoid BigInt serialization issues)
  raisedAmount: string;
  deadline:     number;   // unix timestamp
  status:       number;   // mirrors CampaignStatus enum
  totalMilestones:     number;
  completedMilestones: number;
  donorCount:   number;
  createdAt:    Date;
  updatedAt:    Date;
}

const CampaignSchema = new Schema<ICampaign>(
  {
    campaignId:          { type: Number, required: true, unique: true, index: true },
    orgAddress:          { type: String, required: true, index: true },
    metadataCID:         { type: String, required: true },
    title:               { type: String, default: "" },
    description:         { type: String, default: "" },
    category:            { type: String, default: "general" },
    imageUrl:            { type: String, default: "" },
    orgName:             { type: String, default: "" },
    goalAmount:          { type: String, required: true },
    raisedAmount:        { type: String, default: "0" },
    deadline:            { type: Number, required: true },
    status:              { type: Number, default: 0 },   // 0 = Active
    totalMilestones:     { type: Number, required: true },
    completedMilestones: { type: Number, default: 0 },
    donorCount:          { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Campaign = model<ICampaign>("Campaign", CampaignSchema);
