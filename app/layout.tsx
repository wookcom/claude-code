import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Copilot Workspace',
  description: 'Workspace web real para explorar, diff y ejecutar tareas.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}