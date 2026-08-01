"""Generate a VAPID keypair for Web Push.

Run once, then set the output as Railway env vars:

    python scripts/gen_vapid_keys.py

    VAPID_PUBLIC_KEY   -> the application server key the browser subscribes with
    VAPID_PRIVATE_KEY  -> kept secret on the backend, signs each push
    VAPID_SUBJECT      -> a mailto: (optional; defaults to mailto:ops@brightbase.app)

Requires `pywebpush` (already in requirements.txt), which pulls in `py-vapid`.
"""
from py_vapid import Vapid02
import base64


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def main() -> None:
    v = Vapid02()
    v.generate_keys()

    # Public key: uncompressed EC point (0x04 || X || Y), URL-safe base64.
    pub_numbers = v.public_key.public_numbers()
    x = pub_numbers.x.to_bytes(32, "big")
    y = pub_numbers.y.to_bytes(32, "big")
    public_key = _b64(b"\x04" + x + y)

    # Private key: the raw 32-byte scalar, URL-safe base64.
    priv_value = v.private_key.private_numbers().private_value
    private_key = _b64(priv_value.to_bytes(32, "big"))

    print("VAPID_PUBLIC_KEY=" + public_key)
    print("VAPID_PRIVATE_KEY=" + private_key)
    print("VAPID_SUBJECT=mailto:ops@brightbase.app")


if __name__ == "__main__":
    main()
