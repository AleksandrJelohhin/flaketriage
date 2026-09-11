// demo/pricing.js
//
// A tiny, real source file that exists only so the FlakeTriage demo
// workflow (.github/workflows/demo.yml) has a genuine diff to blame a
// failure against — see "Stage the real_regression fixture" in that
// workflow. Not used by the product itself.

export function applyDiscount(price, pct) {
  return price + price * pct;
}
