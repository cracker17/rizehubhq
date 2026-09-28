# RizeHub pricing (TEMPLATE)

> **Status: TEMPLATE — no prices set yet.** Every `{{…}}` is a placeholder for the CEO to fill.
> **Agent rule:** quote only lines whose price is filled in. If a needed line is missing or still a placeholder, call `ask_ceo`; never estimate, interpolate, or discount. QA checks every quoted number against this file.

## General terms
- Currency: `{{CURRENCY e.g. USD}}` (other currencies: `{{AUD/GBP policy}}`)
- Quote validity: `{{N}}` days
- Deposit: `{{%}}` upfront; balance `{{milestones / on completion}}`
- Payment methods: `{{…}}`
- Revision rounds included: `{{N}}` per deliverable
- Rush fee (under `{{N}}` business days): `{{% or amount}}`
- Change requests / out-of-scope work: billed at `{{hourly rate}}` after written approval
- Discounts allowed: `{{none | rules, e.g. retainer ≥ 6 months = X%}}`
- Third-party costs (apps, themes, fonts, stock, hosting, ad spend): paid by client, not included

## Hourly rates
| Role | Rate |
|---|---|
| Development (Shopify/Webflow/WordPress) | `{{…}}` |
| Full-stack / custom app | `{{…}}` |
| Design (UI/UX, graphic) | `{{…}}` |
| SEO / content | `{{…}}` |
| Video / audio | `{{…}}` |

## Fixed-price packages
| Code | Package | Includes | Timeline | Price |
|---|---|---|---|---|
| SHOP-SPEED | Shopify speed fix | `{{scope}}` | `{{days}}` | `{{price}}` |
| SHOP-SECTION | Custom Shopify section | `{{scope}}` | `{{days}}` | `{{price}}` |
| SHOP-PAGE | Shopify landing/product page | `{{scope}}` | `{{days}}` | `{{price}}` |
| SHOP-THEME | Shopify theme build/migration | `{{scope}}` | `{{days}}` | `{{price}}` |
| WF-PAGE | Webflow page | `{{scope}}` | `{{days}}` | `{{price}}` |
| WF-SITE | Webflow site (up to `{{N}}` pages) | `{{scope}}` | `{{days}}` | `{{price}}` |
| WP-FIX | WordPress fix/maintenance task | `{{scope}}` | `{{days}}` | `{{price}}` |
| WP-SITE | WordPress site (up to `{{N}}` pages) | `{{scope}}` | `{{days}}` | `{{price}}` |
| APP-MVP | Custom web app MVP | `{{scope}}` | `{{weeks}}` | `{{price or "quote only"}}` |
| AUDIT | Site/SEO/CRO audit | `{{scope}}` | `{{days}}` | `{{price}}` |
| DESIGN-UI | UI mockups per page | `{{scope}}` | `{{days}}` | `{{price}}` |
| AD-SET | Ad creative set | `{{sizes, count}}` | `{{days}}` | `{{price}}` |
| VIDEO-REEL | Short-form video edit | `{{length, count}}` | `{{days}}` | `{{price}}` |

## Retainers (monthly)
| Code | Retainer | Includes | Min term | Price/mo |
|---|---|---|---|---|
| RET-SEO | SEO retainer | `{{deliverables}}` | `{{months}}` | `{{price}}` |
| RET-SOCIAL | Social content | `{{posts/mo, platforms}}` | `{{months}}` | `{{price}}` |
| RET-DEV | Dev support hours | `{{hours/mo, rollover rule}}` | `{{months}}` | `{{price}}` |
| RET-GROWTH | Shopify growth | `{{bundle}}` | `{{months}}` | `{{price}}` |

## Free offers agents may make
- `{{e.g. free 3-point mini-audit — confirm yes/no}}`
