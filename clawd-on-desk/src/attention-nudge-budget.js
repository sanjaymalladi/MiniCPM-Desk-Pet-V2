"use strict";

/**
 * @file attention-nudge-budget.js
 *
 * Pure, side-effect-free session budget layer for the Attention Companion v2
 * (Nudge contract + Wander budget, plan §4).
 *
 * The "nudge contract" is the free-text commitment the user makes for the
 * session ("just this report, ignore everything else"). It resolves the
 * doubt-vs-distraction ambiguity at the source: anything that clearly falls
 * within the contract is NOT a distraction.
 *
 * The "wander budget" is a rough per-session tangent allowance set up front.
 * The pet tracks time spent on tangents silently and only surfaces something
 * once the budget is spent.
 *
 * This module does NO NLP and touches NO Electron, network, or filesystem.
 * The caller (attention-decision.js) decides whether an event is "within the
 * contract" using its own title/app heuristics and passes that as a boolean.
 */

class AttentionNudgeBudget {
  constructor() {
    this.reset();
  }

  /**
   * Store the free-text contract the user commits to for the session.
   * A non-empty string activates the contract.
   *
   * @param {string} text
   */
  setContract(text) {
    this._contract = typeof text === "string" ? text : "";
  }

  /**
   * @returns {string} the current contract text ("" when none).
   */
  getContract() {
    return this._contract;
  }

  get _hasContract() {
    return typeof this._contract === "string" && this._contract.trim().length > 0;
  }

  /**
   * Set the per-session tangent allowance in minutes.
   *
   * @param {number} minutes
   */
  setBudget(minutes) {
    const ms = Number(minutes) * 60 * 1000;
    this._budgetMs = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  }

  /**
   * @returns {number} budget in milliseconds (0 when unset).
   */
  getBudgetMs() {
    return this._budgetMs;
  }

  /**
   * Record time spent on a tangent. Silently accumulated; no surfacing.
   *
   * @param {number} minutes
   */
  recordWander(minutes) {
    const ms = Number(minutes) * 60 * 1000;
    const delta = Number.isFinite(ms) ? ms : 0;
    if (delta > 0) this._spentMs += delta;
  }

  /**
   * @returns {boolean} true once accumulated wander >= budget.
   */
  isBudgetSpent() {
    if (this._budgetMs <= 0) return this._spentMs > 0;
    return this._spentMs >= this._budgetMs;
  }

  /**
   * Apply the contract + budget policy to an event.
   *
   * @param {object} event - opaque event payload from the caller (unused here).
   * @param {{withinContract?:boolean}} opts - the decision layer's verdict on
   *        whether the event clearly falls within the contract scope.
   * @returns {"distraction"|"within-contract"|"ambiguous"}
   */
  resolveAmbiguity(event, opts = {}) {
    const withinContract = !!opts.withinContract;

    if (this._hasContract && withinContract) {
      return "within-contract";
    }

    if (this.isBudgetSpent()) {
      return "distraction";
    }

    return "ambiguous";
  }

  /**
   * Clear contract, budget, and accumulated wander — start a new session.
   */
  reset() {
    this._contract = "";
    this._budgetMs = 0;
    this._spentMs = 0;
  }

  /**
   * @returns {{hasContract:boolean, contract:string, budgetMs:number, spentMs:number, spent:boolean}}
   */
  summary() {
    return {
      hasContract: this._hasContract,
      contract: this._contract,
      budgetMs: this._budgetMs,
      spentMs: this._spentMs,
      spent: this.isBudgetSpent(),
    };
  }
}

module.exports = {
  AttentionNudgeBudget,
};
