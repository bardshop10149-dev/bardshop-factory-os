import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * 驗證 token 是否符合 JWT 格式（三段 base64url 以 . 分隔）。
 * 防止偽造的固定字串（例如 "authorized"）通過身份驗證。
 * 注意：此處僅驗證格式，不驗證簽章；完整簽章驗證需搭配 SUPABASE_JWT_SECRET + jose。
 */
function isJwtFormat(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  return parts.every(p => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p))
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname

  // API 路徑不受 middleware 管控
  if (path.startsWith('/api')) {
    return NextResponse.next()
  }

  const rawToken = request.cookies.get('bardshop-token')?.value
  // 只接受符合 JWT 格式的 token（三段 base64url），拒絕舊版固定字串
  const token = rawToken && isJwtFormat(rawToken) ? rawToken : undefined
  const role = request.cookies.get('bardshop-role')?.value
  const permissionsCookie = request.cookies.get('bardshop-permissions')?.value || ''
  const permissions = new Set(
    decodeURIComponent(permissionsCookie)
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  )

  const isPublicPath = path === '/login' || path === '/apply-account' || path === '/upload-photo' || path === '/reset-password'
  const isAdminPath = path.startsWith('/admin')
  const isOpsPath = path.startsWith('/dashboard') || path.startsWith('/estimation') || path.startsWith('/tasks') || path.startsWith('/qa')
  const hasPermissionsCookie = permissions.size > 0

  const hasPermission = (permissionKey: string) => {
    if (role === 'admin') return true
    if (!hasPermissionsCookie) return false
    if (permissionKey === 'system_settings') {
      return permissions.has('system_settings') || permissions.has('production_admin')
    }
    return permissions.has(permissionKey)
  }

  if (token) {
    if (!role && !isPublicPath) {
      const response = NextResponse.redirect(new URL('/login', request.url))
      response.cookies.set('bardshop-token', '', { path: '/', expires: new Date(0) })
      response.cookies.set('bardshop-role', '', { path: '/', expires: new Date(0) })
      response.cookies.set('bardshop-permissions', '', { path: '/', expires: new Date(0) })
      return response
    }

    if (isPublicPath) {
      return NextResponse.redirect(new URL('/', request.url))
    }

    if (!hasPermissionsCookie) {
      if (isAdminPath && role !== 'admin') {
        return NextResponse.redirect(new URL('/403', request.url))
      }

      if (isOpsPath && role !== 'admin' && role !== 'ops') {
        return NextResponse.redirect(new URL('/403', request.url))
      }

      return NextResponse.next()
    }

    if (isAdminPath) {
      const isSystemSettingsPath =
        path.startsWith('/admin/settings') ||
        path.startsWith('/admin/team') ||
        path.startsWith('/admin/system-logs')

      if (isSystemSettingsPath) {
        if (!hasPermission('system_settings')) {
          return NextResponse.redirect(new URL('/403', request.url))
        }
      } else if (!hasPermission('production_admin')) {
        return NextResponse.redirect(new URL('/403', request.url))
      }
    }

    if (isOpsPath) {
      if (path.startsWith('/dashboard') && !hasPermission('dashboard')) {
        return NextResponse.redirect(new URL('/403', request.url))
      }
      if (path.startsWith('/estimation') && !hasPermission('estimation')) {
        return NextResponse.redirect(new URL('/403', request.url))
      }
      if (path.startsWith('/tasks') && !hasPermission('tasks')) {
        return NextResponse.redirect(new URL('/403', request.url))
      }
      if (path.startsWith('/qa') && !hasPermission('qa') && !hasPermission('qa_report')) {
        return NextResponse.redirect(new URL('/403', request.url))
      }
    }
  } else {
    if (!isPublicPath) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
  }
  
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}