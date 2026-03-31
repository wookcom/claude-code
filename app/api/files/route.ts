import { NextResponse } from 'next/server'
import { listWorkspaceFiles } from '../../../lib/workspace'

export const dynamic = 'force-dynamic'

export async function GET() {
  const files = await listWorkspaceFiles()
  return NextResponse.json({ files })
}