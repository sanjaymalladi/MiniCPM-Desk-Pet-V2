"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { AttentionNudgeBudget } = require("../src/attention-nudge-budget");

test("setContract / getContract round-trips and trims activeness", () => {
  const b = new AttentionNudgeBudget();
  assert.equal(b.getContract(), "");
  b.setContract("just this report, ignore everything else");
  assert.equal(b.getContract(), "just this report, ignore everything else");
});

test("reset clears contract, budget and accumulated wander", () => {
  const b = new AttentionNudgeBudget();
  b.setContract("focus on the doc");
  b.setBudget(10);
  b.recordWander(5);
  assert.ok(b.isBudgetSpent() === false);
  b.reset();
  assert.equal(b.getContract(), "");
  assert.equal(b.getBudgetMs(), 0);
  assert.equal(b.summary().spentMs, 0);
  assert.equal(b.summary().hasContract, false);
  assert.equal(b.summary().spent, false);
});

test("budget not spent when wander is under budget", () => {
  const b = new AttentionNudgeBudget();
  b.setBudget(10);
  b.recordWander(4);
  assert.equal(b.isBudgetSpent(), false);
  assert.equal(b.summary().spent, false);
});

test("budget spent when wander reaches budget", () => {
  const b = new AttentionNudgeBudget();
  b.setBudget(10);
  b.recordWander(10);
  assert.equal(b.isBudgetSpent(), true);
  assert.equal(b.summary().spent, true);
});

test("budget spent when wander exceeds budget", () => {
  const b = new AttentionNudgeBudget();
  b.setBudget(10);
  b.recordWander(11);
  assert.equal(b.isBudgetSpent(), true);
});

test("resolveAmbiguity returns within-contract when withinContract and contract active", () => {
  const b = new AttentionNudgeBudget();
  b.setContract("finish the report");
  b.setBudget(10);
  b.recordWander(9);
  assert.equal(b.resolveAmbiguity({ app: "doc" }, { withinContract: true }), "within-contract");
});

test("resolveAmbiguity returns ambiguous when tangent but budget not spent", () => {
  const b = new AttentionNudgeBudget();
  b.setContract("finish the report");
  b.setBudget(10);
  b.recordWander(4);
  assert.equal(b.resolveAmbiguity({ app: "youtube" }, { withinContract: false }), "ambiguous");
});

test("resolveAmbiguity returns distraction only once budget is spent", () => {
  const b = new AttentionNudgeBudget();
  b.setContract("finish the report");
  b.setBudget(10);
  b.recordWander(6);
  assert.equal(b.resolveAmbiguity({ app: "youtube" }, { withinContract: false }), "ambiguous");
  b.recordWander(6);
  assert.equal(b.isBudgetSpent(), true);
  assert.equal(b.resolveAmbiguity({ app: "youtube" }, { withinContract: false }), "distraction");
});

test("resolveAmbiguity returns ambiguous (not within-contract) when no contract active", () => {
  const b = new AttentionNudgeBudget();
  b.setBudget(10);
  assert.equal(b.resolveAmbiguity({ app: "doc" }, { withinContract: true }), "ambiguous");
});

test("summary reflects contract, budget, spent and spentMs", () => {
  const b = new AttentionNudgeBudget();
  b.setContract("ship the feature");
  b.setBudget(15);
  b.recordWander(5);
  const s = b.summary();
  assert.equal(s.hasContract, true);
  assert.equal(s.contract, "ship the feature");
  assert.equal(s.budgetMs, 15 * 60 * 1000);
  assert.equal(s.spentMs, 5 * 60 * 1000);
  assert.equal(s.spent, false);
});
