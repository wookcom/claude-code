import { NextResponse } from 'next/server'
import { readWorkspaceFile } from '../../../lib/workspace'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const relPath = url.searchParams.get('path') ?? ''

  try {
    const content = await readWorkspaceFile(relPath)
    return NextResponse.json({ content })
  } catch {
    return NextResponse.json(
      { error: 'No se pudo leer el archivo.' },
      { status: 400 },
    )
  }
}