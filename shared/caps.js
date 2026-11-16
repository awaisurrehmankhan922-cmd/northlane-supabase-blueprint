// shared/caps.js · the money caps, written once, loaded by the browser and the server.
//
// Same idea as frontend/js/app/caps.js in the CRM: plain functions, no page or Node access.
// The SQL versions live in supabase/migrations/0004_rules.sql (app.deposit_cap_p and
// friends) and test/caps-parity.test.js proves the two never disagree.
//
// All amounts are whole pence (integers). Our caps round DOWN.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NLCAPS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PERIOD_PER_YEAR = { monthly: 12, quarterly: 4, yearly: 1 };
  const HIGH_RENT_P = 5000000; // £50,000 a year

  function annualRentP(rentP, period) {
    const k = PERIOD_PER_YEAR[period];
    if (!k) throw new Error('NO_WEEKLY_RENT: rent is monthly, quarterly or yearly');
    return rentP * k;
  }

  // Tenancy deposit: at most 5 weeks' rent, 6 if rent is £50,000 a year or more.
  function depositCapP(rentP, period) {
    const annual = annualRentP(rentP, period);
    const weeks = annual >= HIGH_RENT_P ? 6 : 5;
    return Math.floor((annual / 52) * weeks);
  }

  // Holding deposit: at most one week's rent.
  function holdingCapP(rentP, period) {
    return Math.floor(annualRentP(rentP, period) / 52);
  }

  // Pro rata: monthly rent × 12 ÷ 365 per day, rounded down (page 7).
  function proRataP(monthlyRentP, days) {
    return Math.floor(((monthlyRentP * 12) / 365) * days);
  }

  // Our cut on a repair: a percentage of the contractor's labour only, rounded down.
  function repairCutP(labourP, pct) {
    return Math.floor((labourP * pct) / 100);
  }

  return { annualRentP, depositCapP, holdingCapP, proRataP, repairCutP, HIGH_RENT_P };
});
