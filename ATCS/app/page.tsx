"use client"
import dynamic from 'next/dynamic'

const FlingApp = dynamic(() => import("@/components/fling-app"), {
  ssr: false,
  loading: () => null // Remove loading text to prevent flash
})

export default function Home() {
  return <FlingApp />
}
