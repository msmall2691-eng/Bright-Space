from fastapi import APIRouter, HTTPException, Depends

from integrations.connecteam import ConnecteamAuthError, get_employees
from modules.auth.router import require_role

router = APIRouter()


@router.get("/employees", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
async def list_employees():
    """Fetch all employees from Connecteam.

    Gated to internal roles: the roster is staff PII (names, phones) and must
    not be reachable by cleaner/client logins. Before this, only the global
    API-key/JWT middleware gated it, so ANY authenticated principal could pull
    the full roster (docs/audit-2026-04-23.md §6)."""
    try:
        return await get_employees()
    except ConnecteamAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {str(e)}")
