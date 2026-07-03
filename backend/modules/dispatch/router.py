from fastapi import APIRouter, HTTPException

from integrations.connecteam import ConnecteamAuthError, get_employees

router = APIRouter()


@router.get("/employees")
async def list_employees():
    """Fetch all employees from Connecteam."""
    try:
        return await get_employees()
    except ConnecteamAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {str(e)}")
