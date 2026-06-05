import { useState, useEffect, useRef, useCallback } from 'react'
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
  const googleBtnRef = useRef(null)

  // Sign in with Google (Google Identity Services). The button hands us an ID
  // token; the backend verifies it and returns the same JWT as password login.
  const handleGoogleCredential = useCallback(async (response) => {
    setError('')
    setLoading(true)
    try {
      const res = await post('/api/auth/google', { credential: response.credential })
      if (res.access_token) {
        setJWT(res.access_token)
        onLoginSuccess?.(res)
        navigate('/dashboard')
      } else {
        setError('Google sign-in failed')
      }
    } catch (err) {
      setError(err.message || 'This Google account isn’t authorized')
    } finally {
      setLoading(false)
    }
  }, [navigate, onLoginSuccess])

  // Load + initialize GSI once, if the server has Google sign-in configured.
  useEffect(() => {
    let cancelled = false
    get('/api/auth/google/config').then(cfg => {
      if (cancelled || !cfg?.enabled || !cfg?.client_id) return
      const init = () => {
        if (!window.google?.accounts?.id) return
        window.google.accounts.id.initialize({
          client_id: cfg.client_id,
          callback: handleGoogleCredential,
        })
        setGoogleEnabled(true)
      }
      if (window.google?.accounts?.id) { init(); return }
      const existing = document.getElementById('google-gsi-script')
      if (existing) { existing.addEventListener('load', init); return }
      const s = document.createElement('script')
      s.src = 'https://accounts.google.com/gsi/client'
      s.async = true; s.defer = true; s.id = 'google-gsi-script'
      s.onload = init
      document.body.appendChild(s)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [handleGoogleCredential])

  // Render (or re-render) the button whenever we're on the login tab.
  useEffect(() => {
    if (googleEnabled && mode === 'login' && googleBtnRef.current && window.google?.accounts?.id) {
      googleBtnRef.current.innerHTML = ''
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'outline', size: 'large', width: 320, text: 'signin_with',
      })
    }
  }, [googleEnabled, mode])

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

          {/* Sign in with Google — only on the login tab, only if configured. */}
          {mode === 'login' && googleEnabled && (
            <div className="mt-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-hairline" />
                <span className="text-xs text-ink-3">or</span>
                <div className="flex-1 h-px bg-hairline" />
              </div>
              <div ref={googleBtnRef} className="flex justify-center" />
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
