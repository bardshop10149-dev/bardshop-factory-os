'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'

interface FavoritesContextType {
  favorites: string[]
  toggleFavorite: (path: string) => void
  loading: boolean
}

const FavoritesContext = createContext<FavoritesContextType | undefined>(undefined)

/**
 * 側欄「我的最愛」。
 * 讀寫一律走 /api/profile/favorites（伺服器端以登入 cookie 認定是誰，只能動自己那一列）；
 * 以前用 anon key 直讀／直改 members，等於任何人都能改任何成員的任何欄位。
 */
export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const [favorites, setFavorites] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  // 伺服器成功認出身分後才允許切換收藏（未登入頁面如 /login 也會掛這個 Provider）
  const [identified, setIdentified] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/profile/favorites')
      .then(async r => (r.ok ? (await r.json()) as { favorites?: string[] } : null))
      .then(d => {
        if (cancelled || !d) return
        setFavorites(Array.isArray(d.favorites) ? d.favorites : [])
        setIdentified(true)
      })
      .catch(e => console.error('讀取我的最愛失敗:', e))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const toggleFavorite = async (path: string) => {
    if (!identified) {
      alert('無法確認您的身份，請嘗試重新登入。')
      return
    }

    const newFavs = favorites.includes(path)
      ? favorites.filter(p => p !== path)
      : [...favorites, path]

    setFavorites(newFavs)

    try {
      const r = await fetch('/api/profile/favorites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorites: newFavs }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string }
        throw new Error(j.error || `HTTP ${r.status}`)
      }
    } catch (e) {
      console.error('更新失敗:', e)
      alert('更新失敗')
      setFavorites(favorites) // 失敗則還原
    }
  }

  return (
    <FavoritesContext.Provider value={{ favorites, toggleFavorite, loading }}>
      {children}
    </FavoritesContext.Provider>
  )
}

export function useFavorites() {
  const context = useContext(FavoritesContext)
  if (context === undefined) {
    throw new Error('useFavorites must be used within a FavoritesProvider')
  }
  return context
}
