import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mail, Lock, AlertCircle, Zap, Loader } from 'lucide-react'
import { post, setJWT } from '../api'

export default function Login({ onLoginSuccess }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-violet-50 flex items-center justify-center px-4">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-200/30 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-violet-200/30 rounded-full blur-3xl"></div>
      </div>

      {/* Card */}
      <div className="relative w-full max-w-md">
        <div className="bg-white/90 backdrop-blur-lg rounded-2xl border border-white/20 shadow-2xl p-8">
          {/* Logo and Header */}
          <div className="flex items-center justify-center mb-8">
            <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center shadow-lg">
              <Zap className="w-6 h-6 text-white" />
            </div>
          </div>

          <h1 className="text-3xl font-bold text-neutral-900 text-center mb-2">BrightBase</h1>
          <p className="text-center text-neutral-500 mb-8">Maine Cleaning Co.</p>

          {/* Error Alert */}
          {error && (
            <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700 font-medium">{error}</p>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email Input */}
            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-neutral-700 mb-2">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 w-5 h-5 text-neutral-400" />
                <input
                  id="email"
                  type="email"
                  required
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  className="w-full pl-10 pr-4 py-3 rounded-lg border border-neutral-200/50 bg-white/50 hover:bg-white/70 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all disabled:opacity-50"
                />
              </div>
            </div>

            {/* Password Input */}
            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-neutral-700 mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 w-5 h-5 text-neutral-400" />
                <input
                  id="password"
                  type="password"
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  className="w-full pl-10 pr-4 py-3 rounded-lg border border-neutral-200/50 bg-white/50 hover:bg-white/70 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all disabled:opacity-50"
                />
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full mt-6 px-4 py-3 bg-gradient-to-r from-blue-600 to-violet-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-violet-700 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  <span>Signing in...</span>
                </>
              ) : (
                <span>Sign in</span>
              )}
            </button>
          </form>

          {/* Footer */}
          <p className="text-center text-xs text-neutral-500 mt-6">
            Contact your administrator for access
          </p>
        </div>
      </div>
    </div>
  )
}
