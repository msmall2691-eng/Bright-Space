import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mail, Lock, AlertCircle, Zap, Loader, Eye, EyeOff } from 'lucide-react'
import { post, get, setJWT } from '../api'

export default function Login({ onLoginSuccess }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState('login') // login, register
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [googleEnabled, setGoogleEnabled] = useState(false)

  // Is unified Google sign-in configured on the server?
  useEffect(() => {
    get('/api/auth/google/config').then(cfg => setGoogleEnabled(!!cfg?.enabled)).catch(() => {})
  }, [])

  // Handle the return from Google's consent screen (one-time code → JWT).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ssoCode = params.get('sso_code')
    const ssoError = params.get('sso_error')
    if (ssoError) {
      setError(ssoError === 'not_authorized'
        ? 'This Google account isn’t authorized. Ask an admin to add it (or set it in GOOGLE_ALLOWED_EMAILS).'
        : 'Google sign-in failed. Please try again.')
      window.history.replaceState({}, '', window.location.pathname)
      return
    }
    if (ssoCode) {
      window.history.replaceState({}, '', window.location.pathname)
      setLoading(true)
      post('/api/auth/google/exchange', { code: ssoCode })
        .then(res => {
          if (res.access_token) {
            setJWT(res.access_token)
            onLoginSuccess?.(res)
            navigate('/dashboard')
          } else {
            setError('Google sign-in failed')
          }
        })
        .catch(err => setError(err.message || 'Google sign-in failed'))
        .finally(() => setLoading(false))
    }
  }, [navigate, onLoginSuccess])

  // Start the unified flow: identity + calendar in one consent.
  const startGoogleSignIn = async () => {
    setError('')
    try {
      const r = await get('/api/auth/google/login-url')
      if (r?.auth_url) window.location.href = r.auth_url
      else setError('Google sign-in isn’t configured')
    } catch (err) {
      setError(err.message || 'Could not start Google sign-in')
    }
  }

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await post('/api/auth/login', {
        email,
        password,
      })

      if (response.access_token) {
        setJWT(response.access_token)
        if (onLoginSuccess) {
          onLoginSuccess(response)
        }
        navigate('/dashboard')
      } else {
        setError('Invalid response from server')
      }
    } catch (err) {
      setError(err.message || 'Failed to log in')
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async (e) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)

    try {
      const response = await post('/api/auth/register', {
        email,
        password,
      })

      if (response.access_token) {
        setJWT(response.access_token)
        if (onLoginSuccess) {
          onLoginSuccess(response)
        }
        navigate('/dashboard')
      } else {
        setError('Registration failed. Try again.')
      }
    } catch (err) {
      setError(err.message || 'Failed to register')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-violet-50 flex items-center justify-center px-4">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-200/30 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-violet-200/30 rounded-full blur-3xl"></div>
      </div>

      {/* Card */}
      <div className="relative w-full max-w-md">
        <div className="bg-panel/90 backdrop-blur-lg rounded-2xl border border-white/20 shadow-2xl p-8">
          {/* Logo and Header */}
          <div className="flex items-center justify-center mb-8">
            <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center shadow-lg">
              <Zap className="w-6 h-6 text-white" />
            </div>
          </div>

          <h1 className="text-3xl font-bold text-ink text-center mb-2">BrightBase</h1>
          <p className="text-center text-ink-3 mb-8">Maine Cleaning Co.</p>

          {/* Error Alert */}
          {error && (
            <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700 font-medium">{error}</p>
            </div>
          )}

          {/* Form */}
          <form onSubmit={mode === 'login' ? handleLogin : handleRegister} className="space-y-4">
            {/* Email Input */}
            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-ink-2 mb-2">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 w-5 h-5 text-ink-3" />
                <input
                  id="email"
                  type="email"
                  required
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  className="w-full pl-10 pr-4 py-3 rounded-lg border border-hairline/50 bg-panel/50 hover:bg-panel/70 focus:bg-panel focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all disabled:opacity-50"
                />
              </div>
            </div>

            {/* Password Input */}
            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-ink-2 mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 w-5 h-5 text-ink-3" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  className="w-full pl-10 pr-12 py-3 rounded-lg border border-hairline/50 bg-panel/50 hover:bg-panel/70 focus:bg-panel focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-3 text-ink-3 hover:text-ink-2"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {/* Forgot Password (Login only) */}
            {mode === 'login' && (
              <div className="text-right">
                <button
                  type="button"
                  onClick={(e) => {
                    const btn = e.currentTarget
                    btn.textContent = 'Contact your administrator to reset'
                    btn.disabled = true
                    btn.classList.add('text-ink-3')
                    btn.classList.remove('text-blue-600', 'hover:text-blue-700')
                    setTimeout(() => {
                      btn.textContent = 'Forgot password?'
                      btn.disabled = false
                      btn.classList.remove('text-ink-3')
                      btn.classList.add('text-blue-600', 'hover:text-blue-700')
                    }, 5000)
                  }}
                  className="text-xs text-blue-600 hover:text-blue-700 font-semibold"
                >
                  Forgot password?
                </button>
              </div>
            )}

            {/* Confirm Password (Register only) */}
            {mode === 'register' && (
              <div>
                <label htmlFor="confirm" className="block text-sm font-semibold text-ink-2 mb-2">
                  Confirm Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 w-5 h-5 text-ink-3" />
                  <input
                    id="confirm"
                    type="password"
                    required
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-3 rounded-lg border border-hairline/50 bg-panel/50 hover:bg-panel/70 focus:bg-panel focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all disabled:opacity-50"
                  />
                </div>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full mt-6 px-4 py-3 bg-gradient-to-r from-blue-600 to-violet-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-violet-700 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  <span>{mode === 'login' ? 'Signing in...' : 'Creating account...'}</span>
                </>
              ) : (
                <span>{mode === 'login' ? 'Sign in' : 'Create Account'}</span>
              )}
            </button>
          </form>

          {/* Sign in with Google — one consent links login + calendar. */}
          {mode === 'login' && googleEnabled && (
            <div className="mt-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-hairline" />
                <span className="text-xs text-ink-3">or</span>
                <div className="flex-1 h-px bg-hairline" />
              </div>
              <button
                type="button"
                onClick={startGoogleSignIn}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-lg border border-hairline bg-panel hover:bg-bg-2 transition-colors disabled:opacity-50 font-medium text-ink"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/>
                </svg>
                Sign in with Google
              </button>
              <p className="text-[11px] text-ink-3 text-center mt-2">Links your Google Calendar in the same step.</p>
            </div>
          )}

          {/* Toggle Register/Login */}
          <div className="text-center text-sm text-ink-2 mt-6">
            {mode === 'login' ? (
              <>
                No account?{' '}
                <button
                  onClick={() => {
                    setMode('register')
                    setError('')
                  }}
                  className="text-blue-600 font-semibold hover:text-blue-700"
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  onClick={() => {
                    setMode('login')
                    setError('')
                  }}
                  className="text-blue-600 font-semibold hover:text-blue-700"
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
