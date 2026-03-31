import { NextResponse } from 'next/server'
import { runSafeCommand } from '../../../lib/workspace'

export const dynamic = 'force-dynamic'

type CommandBody = {
  command?: string
}

export async function POST(request: Request) {
  let body: CommandBody
  try {
    body = (await request.json()) as CommandBody
  } catch {
    return NextResponse.json(
      { error: 'Body JSON invalido.' },
      { status: 400 },
    )
  }

  const command = body.command?.trim() ?? ''
  if (!command) {
    return NextResponse.json({ error: 'Comando vacio.' }, { status: 400 })
  }

  const result = await runSafeCommand(command)
  return NextResponse.json(result)
}