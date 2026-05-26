"use client"

import { cn } from "@/lib/utils"
import { useTheme } from "next-themes"

interface SignalStrengthProps {
  strength: 0 | 1 | 2 | 3 | 4
  className?: string
}

export default function SignalStrength({ strength, className }: SignalStrengthProps) {
  const { theme } = useTheme()
  const activeColor = theme === "light" ? "bg-sky-500" : "bg-teal-400"
  const inactiveColor = theme === "light" ? "bg-slate-300" : "bg-slate-600"

  return (
    <div className={cn("flex items-end h-5 space-x-0.5", className)}>
      <div className={cn("w-1.5 h-1.5 rounded-sm", strength >= 1 ? activeColor : inactiveColor)} />
      <div className={cn("w-1.5 h-2.5 rounded-sm", strength >= 2 ? activeColor : inactiveColor)} />
      <div className={cn("w-1.5 h-3.5 rounded-sm", strength >= 3 ? activeColor : inactiveColor)} />
      <div className={cn("w-1.5 h-4.5 rounded-sm", strength >= 4 ? activeColor : inactiveColor)} />
    </div>
  )
}
