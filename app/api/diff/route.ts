import { NextResponse } from 'next/server'
import { gitDiffForFile } from '../../../lib/workspace'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const relPath = url.searchParams.get('path') ?? ''

  try {
    const diff = await gitDiffForFile(relPath)
    return NextResponse.json({ diff })
  } catch {
    return NextResponse.json(
      { error: 'No se pudo obtener diff para ese archivo.' },
      { status: 400 },
    )
  }
}