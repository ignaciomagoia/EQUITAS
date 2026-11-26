'use client'

import type { ComponentProps } from 'react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { signOutCurrentSession } from '@/lib/services/auth-service'
import { useAuthState } from '@/components/auth/auth-provider'
import { cn } from '@/lib/utils'

type LogoutButtonProps = {
  className?: string
  variant?: ComponentProps<typeof Button>['variant']
}

export function LogoutButton({
  className,
  variant = 'outline',
}: LogoutButtonProps) {
  const router = useRouter()
  const { source } = useAuthState()
  const [isLoading, setIsLoading] = useState(false)

  async function handleLogout() {
    setIsLoading(true)
    await signOutCurrentSession(source)
    await fetch('/api/auth/source', { method: 'DELETE' })
    router.replace('/login')
    router.refresh()
  }

  return (
    <Button
      variant={variant}
      size="sm"
      onClick={handleLogout}
      disabled={isLoading}
      className={cn('h-8', className)}
    >
      <LogOut className="size-3.5" />
      {isLoading ? 'Saliendo...' : 'Cerrar sesion'}
    </Button>
  )
}
