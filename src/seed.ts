import mongoose from "mongoose";
import dotenv from "dotenv";
import { Campaign } from "./models/Campaign";
import { Donation } from "./models/Donation";
import { Proposal } from "./models/Proposal";

dotenv.config();

async function main () {
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/transpachain");
    console.log("[Seed] MongoDB connected");

    // Clear existing data
    await Promise.all([
        Campaign.deleteMany({}),
        Donation.deleteMany({}),
        Proposal.deleteMany({}),
    ]);
    console.log("[Seed] Cleared existing data");

    // ── Campaigns ─────────────────────────────────────────────────
    const campaigns = await Campaign.insertMany([
        {
          campaignId:          1,
          orgAddress:          "0xa7ac8154fa3019f5e95ba3720240c782c0e3ed70",
          metadataCID:         "QmDemoKenya",
          title:               "Build Schools in Rural Kenya",
          description:         "Help build 3 primary schools serving 600 children in remote areas of Kisumu County, Kenya.",
          category:            "education",
          imageUrl:            "https://images.unsplash.com/photo-1580582932707-520aed937b7b?w=800",
          orgName:             "Education For All Foundation",
          goalAmount:          "2000000000000000000",
          raisedAmount:        "1200000000000000000",
          deadline:            Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          status:              0,
          totalMilestones:     3,
          completedMilestones: 0,
          donorCount:          8,
          cancelledAt:         0,
          paymentToken:        0,
        },
        {
          campaignId:          2,
          orgAddress:          "0xa7ac8154fa3019f5e95ba3720240c782c0e3ed70",
          metadataCID:         "QmDemoTurkey",
          title:               "Turkey Earthquake Relief Fund 2024",
          description:         "Providing emergency shelter, food, and medical aid to 2,000 families displaced by the earthquake.",
          category:            "disaster",
          imageUrl:            "https://images.unsplash.com/photo-1547683905-f686c993aae5?w=800",
          orgName:             "Global Disaster Response",
          goalAmount:          "5000000000000000000",
          raisedAmount:        "5000000000000000000",
          deadline:            Math.floor(Date.now() / 1000) + 15 * 24 * 3600,
          status:              0,
          totalMilestones:     3,
          completedMilestones: 1,
          donorCount:          15,
          cancelledAt:         0,
          paymentToken:        0,
        },
        {
          campaignId:          3,
          orgAddress:          "0xa7ac8154fa3019f5e95ba3720240c782c0e3ed70",
          metadataCID:         "QmDemoBangladesh",
          title:               "Clean Water Wells in Bangladesh",
          description:         "Successfully drilled 20 clean water wells providing safe drinking water to 5,000 villagers.",
          category:            "healthcare",
          imageUrl:            "https://images.unsplash.com/photo-1509062522246-3755977927d7?w=800",
          orgName:             "WaterAid International",
          goalAmount:          "3000000000000000000",
          raisedAmount:        "3000000000000000000",
          deadline:            Math.floor(Date.now() / 1000) - 5 * 24 * 3600,
          status:              1,
          totalMilestones:     2,
          completedMilestones: 2,
          donorCount:          12,
          cancelledAt:         0,
          paymentToken:        0,
        },
      ]);
      console.log(`[Seed] Inserted ${campaigns.length} campaigns`);

      // ── Donations ─────────────────────────────────────────────────
      const donations = await Donation.insertMany([
        // Campaign 1 — Kenya
        { campaignId: 1, donor: "0xd001000000000000000000000000000000000001", amount: "500000000000000000", txHash: "0xdemo_tx_001", blockNumber: 8000001, tokenType: 0, status: "locked" },
        { campaignId: 1, donor: "0xd002000000000000000000000000000000000002", amount: "300000000000000000", txHash: "0xdemo_tx_002", blockNumber: 8000050, tokenType: 0, status: "locked" },
        { campaignId: 1, donor: "0xd003000000000000000000000000000000000003", amount: "200000000000000000", txHash: "0xdemo_tx_003", blockNumber: 8000100, tokenType: 0, status: "locked" },
        { campaignId: 1, donor: "0xd004000000000000000000000000000000000004", amount: "100000000000000000", txHash: "0xdemo_tx_004", blockNumber: 8000150, tokenType: 0, status: "locked" },
        { campaignId: 1, donor: "0xd005000000000000000000000000000000000005", amount: "100000000000000000", txHash: "0xdemo_tx_005", blockNumber: 8000200, tokenType: 0, status: "locked" },
    
        // Campaign 2 — Turkey
        { campaignId: 2, donor: "0xd001000000000000000000000000000000000001", amount: "1000000000000000000", txHash: "0xdemo_tx_006", blockNumber: 8001001, tokenType: 0, status: "released" },
        { campaignId: 2, donor: "0xd002000000000000000000000000000000000002", amount: "1000000000000000000", txHash: "0xdemo_tx_007", blockNumber: 8001050, tokenType: 0, status: "released" },
        { campaignId: 2, donor: "0xd006000000000000000000000000000000000006", amount: "2000000000000000000", txHash: "0xdemo_tx_008", blockNumber: 8001100, tokenType: 0, status: "released" },
        { campaignId: 2, donor: "0xd007000000000000000000000000000000000007", amount: "1000000000000000000", txHash: "0xdemo_tx_009", blockNumber: 8001150, tokenType: 0, status: "locked" },
    
        // Campaign 3 — Bangladesh
        { campaignId: 3, donor: "0xd001000000000000000000000000000000000001", amount: "1000000000000000000", txHash: "0xdemo_tx_010", blockNumber: 8002001, tokenType: 0, status: "released" },
        { campaignId: 3, donor: "0xd003000000000000000000000000000000000003", amount: "500000000000000000", txHash: "0xdemo_tx_011", blockNumber: 8002050, tokenType: 0, status: "released" },
        { campaignId: 3, donor: "0xd008000000000000000000000000000000000008", amount: "1500000000000000000", txHash: "0xdemo_tx_012", blockNumber: 8002100, tokenType: 0, status: "released" },
      ]);
      console.log(`[Seed] Inserted ${donations.length} donations`);

      // ── Proposals ─────────────────────────────────────────────────
      const proposals = await Proposal.insertMany([
        // Campaign 2 — milestone 1 đang active voting
        {
          proposalId:     1,
          campaignId:     2,
          milestoneIndex: 1,
          proofCID:       "QmProofTurkey_M1",
          state:          1,  // Active
          forVotes:       3000000000000000000,
          againstVotes:   0,
          abstainVotes:   0,
          endBlock:       9999999,
          executeAfter:   0,
          txHash:         "0xdemo_proposal_001",
        },
        // Campaign 3 — milestone 0 đã executed
        {
          proposalId:     2,
          campaignId:     3,
          milestoneIndex: 0,
          proofCID:       "QmProofBangladesh_M0",
          state:          4,  // Executed
          forVotes:       3000000000000000000,
          againstVotes:   0,
          abstainVotes:   0,
          endBlock:       7999999,
          executeAfter:   0,
          txHash:         "0xdemo_proposal_002",
        },
        // Campaign 3 — milestone 1 đã executed
        {
          proposalId:     3,
          campaignId:     3,
          milestoneIndex: 1,
          proofCID:       "QmProofBangladesh_M1",
          state:          4,  // Executed
          forVotes:       3000000000000000000,
          againstVotes:   0,
          abstainVotes:   0,
          endBlock:       7999999,
          executeAfter:   0,
          txHash:         "0xdemo_proposal_003",
        },
      ]);
      console.log(`[Seed] Inserted ${proposals.length} proposals`);

      console.log("[Seed] ✅ Done!");
      await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); })