# Instant-quote integration for maineclean.co

The `/api/booking/instant-quote` endpoint is **public** (no API key, no JWT).
Drop the snippet below into the booking form on maineclean.co to show a
live price range as the customer fills it in.

## Endpoint

```
POST https://brightbase-production.up.railway.app/api/booking/instant-quote
Content-Type: application/json

{
  "serviceType": "residential-cleaning" | "deep-cleaning" | "move-in-out"
                 | "commercial-cleaning" | "airbnb-turnover" | "str-turnover",
  "bedrooms":     2,        // optional
  "bathrooms":    1,        // optional
  "squareFeet":   1200,     // optional
  "frequency":    "weekly", // optional — "weekly" | "biweekly" | "monthly" | "one-time"
  "message":      "..."     // optional — keyword "deep" / "move-in" / "move-out" picked up here too
}
```

Returns:

```json
{
  "estimate_min": 165,
  "estimate_max": 205,
  "currency": "USD",
  "breakdown": {
    "base": 120,
    "service_type": "residential",
    "extra_bedrooms": { "count": 1, "subtotal": 25 },
    "extra_bathrooms": { "count": 1, "subtotal": 18 },
    "extra_sqft": { "square_footage": 1500, "bands": 1, "subtotal": 22 },
    "pre_round_mid": 185
  }
}
```

The `breakdown` is for debugging — don't show it to customers. Show the
`estimate_min` / `estimate_max` as `"$165–$205"`.

## Drop-in JS for the booking form

Assumes your form has inputs with the names below (`service_type`,
`bedrooms`, etc.) and a span/div with id `quote-display` somewhere
near the submit button.

```html
<div id="quote-display" class="instant-quote">
  <span class="label">Estimated price</span>
  <span class="range">Fill in details for a live estimate</span>
</div>

<script>
  const QUOTE_URL = "https://brightbase-production.up.railway.app/api/booking/instant-quote";

  // Debounce so we don't spam the endpoint on every keystroke.
  let timer = null;
  async function refreshQuote() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const form = document.querySelector("form");           // or your form selector
      const fd = new FormData(form);
      const body = {
        serviceType: fd.get("service_type") || fd.get("serviceType") || "residential-cleaning",
        bedrooms:    parseInt(fd.get("bedrooms"))   || null,
        bathrooms:   parseInt(fd.get("bathrooms"))  || null,
        squareFeet:  parseInt(fd.get("squareFeet") || fd.get("square_feet")) || null,
        frequency:   fd.get("frequency") || null,
        message:     fd.get("message")   || null,
      };
      // Only call once we know enough to be useful.
      if (!body.serviceType) return;

      try {
        const res = await fetch(QUOTE_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });
        if (!res.ok) return;
        const q = await res.json();
        document.querySelector("#quote-display .range").textContent =
          `$${q.estimate_min}–$${q.estimate_max}`;
      } catch (_) {
        // Network blip — keep the previous estimate.
      }
    }, 250);
  }

  // Wire it up on every relevant input.
  ["service_type","serviceType","bedrooms","bathrooms",
   "squareFeet","square_feet","frequency","message"].forEach((name) => {
    document.querySelectorAll(`[name="${name}"]`).forEach((el) => {
      el.addEventListener("input",  refreshQuote);
      el.addEventListener("change", refreshQuote);
    });
  });

  // Show an estimate on first load if we have any defaults.
  refreshQuote();
</script>

<style>
  .instant-quote {
    margin: 1rem 0;
    padding: 0.75rem 1rem;
    background: #f0f9ff;
    border: 1px solid #bae6fd;
    border-radius: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .instant-quote .label { font-size: 0.85rem; color: #0c4a6e; }
  .instant-quote .range { font-size: 1.5rem; font-weight: 700; color: #0369a1; }
</style>
```

## Tuning prices

Pricing lives entirely in `backend/modules/booking/pricing.py`. The
constants at the top of that file (BASE_PRICE, PER_EXTRA_BEDROOM_USD,
DEEP_CLEAN_MULTIPLIER, FREQUENCY_DISCOUNT, etc.) are the only things you
need to touch. Edit, commit, redeploy — every instant-quote *and*
every new LeadIntake's `estimate_min`/`estimate_max` will use the new
rates immediately.

## Where the estimate shows up inside BrightBase

Every booking submitted via `/api/booking/submit` now auto-populates the
LeadIntake's `estimate_min` and `estimate_max` columns using the same
pricing engine. The Requests page can surface this as a price chip on
each row (follow-up FE work — out of scope for the initial integration).
