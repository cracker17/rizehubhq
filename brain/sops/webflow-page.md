# SOP: webflow-page

Owner: web-dev. Output: a new or rebuilt Webflow page (static or CMS template) built in the Designer with Client-First structure, tested on staging, NOT published to the custom domain.

## Inputs to confirm
Site, page name/slug, design (Figma frame or reference), approved copy, assets (licensed), CTA destinations, form behaviour (who receives submissions), SEO title/description/OG image. Missing copy, form recipient or CTA URL → `ask_ceo`.

## Steps
1. `vault_list` → Designer login (and site token). `vault_login` to the Designer; `vault_request_2fa` if asked.
2. **Audit the site system** before adding anything: Style Guide page, variables (colours, sizes, fonts), existing utility classes, Components, global nav/footer. Note what you will reuse. Screenshot a similar existing page for baseline Lighthouse.
3. **Page skeleton (Client-First):**
   ```
   page-wrapper
     [Navbar component]
     main-wrapper (tag: main)
       section_hero (tag: section)
         padding-global > container-large > padding-section-large > hero_component
       section_features …
     [Footer component]
   ```
   Class names: `[section]_[element]` (`hero_content`, `features_grid`), combo `is-[variant]`. Never leave default names (`Div Block 12`).
4. **Build sections** from the design. Use variables and existing text/button styles; rem units; Flex/Grid; max-widths via container classes. Repeated patterns (cards, CTA bands) become Components with props for text/image/link.
5. **Responsive:** style desktop first in Webflow's cascade, then check/fix 991, 767, 478 px. No fixed heights on text containers; no horizontal overflow (check with Designer's overflow warnings and `playwright`).
6. **Content:** paste approved copy exactly; mark placeholders `[PLACEHOLDER: …]`. One H1; logical H2/H3; alt text on every meaningful image, decorative images marked decorative.
7. **Images:** upload WebP/AVIF, sized ≤ 2× display width; lazy by default, hero image set to eager. Fonts: only licensed, only weights used.
8. **Forms:** native form with labelled fields, success/error states, honeypot or reCAPTCHA/Turnstile per site standard. Don't change form notification settings without approval.
9. **Page settings:** slug, title (≤ 60 chars), meta description (≤ 155), OG title/description/image, canonical if needed, exclude from search only if brief says. For CMS templates bind dynamic fields.
10. **Custom code** (if any): per `brain/sops/webflow-interaction.md` standards; page-level `<head>`/before `</body>`.
11. **Staging:** request staging publish via `request_external_action` (unless scope note allows staging-only publish). Test on `*.webflow.io` at 375/768/992/1440: layout, links (`link_checker`), form submit to test state, keyboard, console, Lighthouse mobile.
12. `submit_output`: page URL on staging, Designer page name, new classes/components list, placeholders, SEO fields, screenshots, Lighthouse, criteria map, and the exact publish action for CEO approval.

## Handoff note template
```
Page: /services/roof-repair (staging: https://<site>.webflow.io/services/roof-repair)
New classes: section_services-hero, services-hero_content, … | Components reused: CTA Band, Card
Placeholders: 2 (testimonial, stat) | SEO: title 54 chars, description 148 chars
Tested: 375/768/992/1440, form test submission, keyboard, LH mobile 88/96/100/100
Needs approval: Publish to custom domain
```
