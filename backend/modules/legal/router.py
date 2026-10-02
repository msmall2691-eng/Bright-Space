"""Public legal pages — served server-side, WITHOUT JavaScript.

Why this exists: maineclean.co is a single-page app whose backend serves the
same JS-only shell for every route (main.py's `/{full_path:path}` catch-all).
So /privacy, /terms and /sms all returned HTTP 200 with only the homepage
<title> and no policy text. A carrier's A2P/10DLC reviewer fetches the declared
privacy-policy URL WITHOUT running JavaScript and would find a page that
technically succeeds and contains no policy — a rejection reason for the 10DLC
campaign that gates all outbound SMS. Search crawlers saw the same empty shell.

These routes are registered in main.py BEFORE that catch-all, so /privacy,
/terms and /sms now return real, crawlable, self-contained HTML with the actual
policy text and the 10DLC essentials (opt-in, STOP/HELP, "message and data rates
may apply", "we don't sell your data"). They are non-/api paths, so auth.py's
_is_public waves them through without a key.

The policy text lives in content.py; this module only frames it.
"""
from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from . import content

router = APIRouter(tags=["legal"])

# Shared, self-contained frame. Inline CSS only (no external fetches, no JS), so
# it renders identically for a no-JS carrier reviewer, a crawler, and a person.
# Light, clean, tokenless (this is a public static page, not the themed app).
_FRAME = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="index, follow">
<title>{title} — {company}</title>
<meta name="description" content="{description}">
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: #f7f7f5; color: #1c1d21;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }}
  .wrap {{ max-width: 720px; margin: 0 auto; padding: 24px 20px 72px; }}
  header.site {{ display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    padding-bottom: 16px; margin-bottom: 24px; border-bottom: 1px solid #e6e6e2; }}
  header.site .name {{ font-weight: 700; font-size: 15px; letter-spacing: -.01em; }}
  header.site a {{ color: #4b4f5a; text-decoration: none; font-size: 13px; }}
  header.site a:hover {{ color: #1c1d21; }}
  header.site nav {{ margin-left: auto; display: flex; gap: 16px; }}
  h1 {{ font-size: 28px; letter-spacing: -.02em; margin: 0 0 4px; text-wrap: balance; }}
  .eff {{ color: #82858f; font-size: 13px; margin: 0 0 28px; }}
  h2 {{ font-size: 17px; letter-spacing: -.01em; margin: 32px 0 8px; }}
  p, li {{ color: #33353c; }}
  ul {{ padding-left: 22px; }}
  li {{ margin: 4px 0; }}
  a {{ color: #4f46e5; }}
  strong {{ color: #1c1d21; }}
  footer.site {{ margin-top: 48px; padding-top: 20px; border-top: 1px solid #e6e6e2;
    font-size: 13px; color: #82858f; display: flex; gap: 16px; flex-wrap: wrap; }}
  footer.site a {{ color: #4b4f5a; text-decoration: none; }}
  footer.site a:hover {{ color: #1c1d21; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #0f1013; color: #eceef2; }}
    header.site, footer.site {{ border-color: #26282e; }}
    header.site a, footer.site, footer.site a {{ color: #9aa0ab; }}
    header.site a:hover, footer.site a:hover {{ color: #eceef2; }}
    p, li {{ color: #c7cad1; }}
    strong {{ color: #ffffff; }}
    a {{ color: #a5abff; }}
    .eff {{ color: #7c8089; }}
  }}
</style>
</head>
<body>
<div class="wrap">
  <header class="site">
    <span class="name">{company}</span>
    <a href="https://{host}/">{host}</a>
    <nav>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="/sms">SMS</a>
    </nav>
  </header>
  <main>
    <h1>{title}</h1>
    <p class="eff">Effective {effective}</p>
    {body}
  </main>
  <footer class="site">
    <span>© {company}</span>
    <a href="/privacy">Privacy Policy</a>
    <a href="/terms">Terms of Service</a>
    <a href="/sms">SMS Terms</a>
  </footer>
</div>
</body>
</html>"""


def _page(title: str, description: str, body: str) -> HTMLResponse:
    html = _FRAME.format(
        title=title,
        description=description,
        company=content.COMPANY,
        host=content.SITE_HOST,
        effective=content.EFFECTIVE_DATE,
        body=body,
    )
    # Public, cacheable — but short, so an updated policy propagates within the
    # hour rather than being pinned in a CDN/browser for a day.
    return HTMLResponse(html, headers={"Cache-Control": "public, max-age=3600"})


@router.get("/privacy", include_in_schema=False)
def privacy():
    return _page("Privacy Policy",
                 f"How {content.COMPANY} collects, uses, and protects your information.",
                 content.PRIVACY_BODY)


@router.get("/terms", include_in_schema=False)
def terms():
    return _page("Terms of Service",
                 f"The terms that govern {content.COMPANY}'s services and website.",
                 content.TERMS_BODY)


@router.get("/sms", include_in_schema=False)
def sms():
    return _page("SMS Terms",
                 f"{content.COMPANY}'s text-messaging program: opt-in, message frequency, "
                 "rates, and how to opt out (STOP) or get help (HELP).",
                 content.SMS_BODY)
