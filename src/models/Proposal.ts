import { Schema, model, Document } from "mongoose";

export interface IProposal extends Document {
  proposalId:     number;
  campaignId:     number;
  milestoneIndex: number;
  proofCID:       string;
  state:          number;  // ProposalState enum
  forVotes:       number;
  againstVotes:   number;
  abstainVotes:   number;
  endBlock:       number;
  executeAfter:   number;
  txHash:         string;
  createdAt:      Date;
}

const ProposalSchema = new Schema<IProposal>(
  {
    proposalId:     { type: Number, required: true, unique: true, index: true },
    campaignId:     { type: Number, required: true, index: true },
    milestoneIndex: { type: Number, required: true },
    proofCID:       { type: String, default: "" },
    state:          { type: Number, default: 1 },  // 1 = Active
    forVotes:       { type: Number, default: 0 },
    againstVotes:   { type: Number, default: 0 },
    abstainVotes:   { type: Number, default: 0 },
    endBlock:       { type: Number, required: true },
    executeAfter:   { type: Number, default: 0 },
    txHash:         { type: String, required: true },
  },
  { timestamps: true }
);

export const Proposal = model<IProposal>("Proposal", ProposalSchema);
