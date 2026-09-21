"""Legal page content for The Maine Cleaning Co.

Plain HTML fragments (bodies only — the shared frame lives in router.py). These
are served server-side, WITHOUT JavaScript, so a carrier's A2P/10DLC reviewer
and search crawlers see real policy text at /privacy, /terms and /sms — the SPA
shell that used to answer those URLs contained only the homepage title.

⚠️  REVIEW BEFORE RELYING ON THIS AS YOUR OFFICIAL POLICY.
These are standard, good-faith policies for a residential/short-term-rental
cleaning business that texts customers through Twilio. They are NOT legal advice
and were drafted by an assistant, not a lawyer. Confirm the registered entity
name, the contact address, and anything business-specific (what you collect, who
you share it with, retention) before this is treated as binding. Update
EFFECTIVE_DATE whenever the text changes.
"""

# —— Business facts (confirm these) ——————————————————————————————————————————
COMPANY = "The Maine Cleaning Co."
SITE_HOST = "maineclean.co"
# The office inbox that actually receives mail (maineclean.co has no MX records,
# so the address on that domain bounces — see the deliverability note in the PR).
CONTACT_EMAIL = "office@mainecleaningco.com"
EFFECTIVE_DATE = "September 21, 2026"

# —— Privacy Policy ————————————————————————————————————————————————————————————
PRIVACY_BODY = f"""
<p>{COMPANY} (“we,” “us,” “our”) operates a residential and short-term-rental
cleaning business in Southern Maine. This policy explains what personal
information we collect, how we use it, and the choices you have. It applies to
our website, our booking and quote forms, and the text messages and emails we
send you.</p>

<h2>Information we collect</h2>
<ul>
  <li><strong>Contact details</strong> — your name, phone number, email address
      and service address, provided when you request a quote, book a clean, or
      message us.</li>
  <li><strong>Property and service details</strong> — information needed to
      perform the work, such as the size and type of property, access
      instructions you choose to share, and notes about the job.</li>
  <li><strong>Communications</strong> — the content of texts, emails, calls and
      voicemails between you and us, so we can respond and keep a record of the
      service.</li>
  <li><strong>Payment information</strong> — payments are processed by our
      payment provider (Square). We receive confirmation and basic transaction
      details; we do not store full card numbers.</li>
  <li><strong>Website usage</strong> — basic technical data (such as IP address
      and pages viewed) needed to operate and secure the site.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To provide quotes, schedule and perform cleaning services, and manage your
      account.</li>
  <li>To communicate with you about appointments, service updates, and your
      requests — including by text message where you have opted in (see our
      <a href="/sms">SMS Terms</a>).</li>
  <li>To send invoices and process payments.</li>
  <li>To operate, secure, and improve our business and our website.</li>
  <li>To comply with legal obligations.</li>
</ul>

<h2>How we share it</h2>
<p><strong>We do not sell or rent your personal information, and we do not share
it with third parties for their own marketing.</strong> We share information only
with service providers who help us run the business, and only as needed to do so:</p>
<ul>
  <li><strong>Twilio</strong> — to send and receive text messages and calls.</li>
  <li><strong>Square</strong> — to process payments.</li>
  <li><strong>Google / Gmail</strong> — to send and receive email and manage
      scheduling.</li>
  <li>Our vetted cleaning contractors — limited to the details needed to perform
      your specific job.</li>
</ul>
<p>We may also disclose information if required by law, or to protect the rights,
property, or safety of our customers, our staff, or the public.</p>

<h2>Text messaging</h2>
<p>Information you share when you consent to text messaging, and your consent
itself, are used only to send you the messages you asked for. <strong>We do not
share your mobile opt-in or phone number with third parties or affiliates for
marketing purposes.</strong> Message and data rates may apply. Reply STOP to opt
out at any time and HELP for help. Full details are in our
<a href="/sms">SMS Terms</a>.</p>

<h2>Data retention</h2>
<p>We keep personal information for as long as needed to provide our services and
to meet legal, tax, and accounting requirements, then delete or de-identify it.</p>

<h2>Security</h2>
<p>We use reasonable administrative, technical, and physical safeguards to
protect your information. No method of transmission or storage is completely
secure, so we cannot guarantee absolute security.</p>

<h2>Your choices</h2>
<ul>
  <li>You can opt out of text messages at any time by replying STOP.</li>
  <li>You can ask us to access, correct, or delete the personal information we
      hold about you by contacting us at the address below.</li>
</ul>

<h2>Children</h2>
<p>Our services are for adults. We do not knowingly collect personal information
from children under 13.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy from time to time. The effective date above shows
when it was last revised.</p>

<h2>Contact us</h2>
<p>Questions about this policy or your information? Email
<a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.</p>
"""

# —— Terms of Service ——————————————————————————————————————————————————————————
TERMS_BODY = f"""
<p>These Terms govern your use of the {COMPANY} website and the cleaning services
we provide. By booking a service or using our site, you agree to these Terms.</p>

<h2>Our services</h2>
<p>We provide residential and short-term-rental (STR) cleaning and turnover
services in Southern Maine. The specific scope, schedule, and price for your job
are set out in your quote or booking confirmation.</p>

<h2>Quotes, booking, and payment</h2>
<ul>
  <li>Quotes are estimates based on the information you provide and may be
      adjusted if the actual scope differs materially.</li>
  <li>Payment is due as stated on your invoice. Payments are processed securely
      by Square.</li>
  <li>Prices, taxes, and fees are as shown in your quote or invoice.</li>
</ul>

<h2>Scheduling, access, and cancellations</h2>
<ul>
  <li>You are responsible for providing safe, timely access to the property
      (keys, codes, or other arrangements) at the scheduled time.</li>
  <li>If we cannot access the property or the visit is cancelled with short
      notice, a fee may apply as described in your quote or booking.</li>
  <li>We will make reasonable efforts to meet scheduled times, but times may be
      affected by weather, traffic, or circumstances beyond our control.</li>
</ul>

<h2>Your responsibilities</h2>
<ul>
  <li>Provide accurate information about the property and the work needed.</li>
  <li>Secure or remove valuable, fragile, or hazardous items before a visit.</li>
  <li>Ensure any access details you share are accurate and that you are
      authorized to share them.</li>
</ul>

<h2>Satisfaction</h2>
<p>If something isn't right, contact us promptly and we will work to make it
right, consistent with the terms of your specific service.</p>

<h2>Limitation of liability</h2>
<p>To the fullest extent permitted by law, {COMPANY} is not liable for indirect,
incidental, or consequential damages arising from our services or your use of the
site. Our total liability for any claim is limited to the amount you paid for the
service giving rise to the claim.</p>

<h2>Communications</h2>
<p>By providing your contact information, you agree that we may contact you about
your service by phone, email, and — where you have opted in — text message. See
our <a href="/sms">SMS Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>

<h2>Changes to these Terms</h2>
<p>We may update these Terms from time to time. The effective date above shows
when they were last revised. Continued use of our services means you accept the
current Terms.</p>

<h2>Governing law</h2>
<p>These Terms are governed by the laws of the State of Maine, without regard to
its conflict-of-laws rules.</p>

<h2>Contact us</h2>
<p>Questions about these Terms? Email
<a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.</p>
"""

# —— SMS / Messaging Terms (the A2P / 10DLC page) ——————————————————————————————
SMS_BODY = f"""
<p>{COMPANY} sends text messages to customers who have provided their mobile
number and agreed to receive them. This page describes our messaging program.</p>

<h2>Program description</h2>
<p>When you give us your mobile number — for example on a quote request, a
booking form, or by texting us — you agree that we may send you text messages
related to your service, such as:</p>
<ul>
  <li>Appointment confirmations, reminders, and schedule changes;</li>
  <li>Updates about a job in progress or completed;</li>
  <li>Replies to your questions and requests;</li>
  <li>Quotes, invoices, and payment reminders.</li>
</ul>
<p>These are transactional, service-related messages tied to your relationship
with us — not marketing blasts.</p>

<h2>Message frequency</h2>
<p>Message frequency varies and depends on your activity with us (for example,
how many appointments or requests you have). You will generally receive messages
only when there is something about your service to tell you.</p>

<h2>Cost</h2>
<p><strong>Message and data rates may apply.</strong> Your mobile carrier's
standard rates apply to messages you send and receive. {COMPANY} does not charge
you for text messages.</p>

<h2>How to opt out</h2>
<p>You can cancel text messages at any time by replying <strong>STOP</strong> to
any message from us. After you send STOP, we will send one confirmation message
and will not send you further texts unless you opt back in. To opt back in, reply
<strong>START</strong> or contact us.</p>

<h2>How to get help</h2>
<p>Reply <strong>HELP</strong> to any message for help, or email us at
<a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.</p>

<h2>Carriers</h2>
<p>Carriers are not liable for delayed or undelivered messages.</p>

<h2>Privacy</h2>
<p><strong>We do not sell or share your mobile number or your opt-in with third
parties or affiliates for marketing purposes.</strong> Your number is used only
to send the service messages described here. See our
<a href="/privacy">Privacy Policy</a> for how we handle your information.</p>

<h2>Contact us</h2>
<p>Questions about our messaging program? Email
<a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.</p>
"""
