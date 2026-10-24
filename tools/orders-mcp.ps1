# Strict mode off: MCP servers must never die on an unexpected property.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$ordersPath = if ($env:ORDERS_MCP_FILE) { $env:ORDERS_MCP_FILE } else { Join-Path $repoRoot 'ORDERS.md' }

function Write-Message($message) {
  $json = $message | ConvertTo-Json -Depth 20 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Reply($id, $result) {
  Write-Message @{ jsonrpc = '2.0'; id = $id; result = $result }
}

function Reply-Error($id, $code, $message) {
  Write-Message @{ jsonrpc = '2.0'; id = $id; error = @{ code = $code; message = $message } }
}

function Tool-Text($text, $isError = $false) {
  return @{ content = @(@{ type = 'text'; text = $text }); isError = $isError }
}

function Get-Arg($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

# Orders look like:
#   ## ORD-001 - title
#   priority: high
#   status: open
#   ...
#   result:
#   ---
function Read-Orders {
  if (-not (Test-Path -LiteralPath $ordersPath)) { throw "ORDERS.md not found at $ordersPath" }
  $lines = @(Get-Content -LiteralPath $ordersPath -Encoding UTF8)
  $blocks = @()
  $cur = $null
  $inFence = $false

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    # The template at the top is a fenced example, not a real order.
    if ($line -match '^\s*```') { $inFence = -not $inFence; continue }
    if ($inFence) { continue }
    if ($line -match '^##\s+(ORD-\d+)\s+(.*)$') {
      if ($cur) { $cur.End = $i; $blocks += $cur }
      $title = $Matches[2] -replace '^[\u2013\u2014-]\s*', ''
      $cur = [pscustomobject]@{
        Id     = $Matches[1]
        Title  = $title.Trim()
        Fields = @{}
        Start  = $i
        End    = $lines.Count
      }
    }
    elseif ($cur -and $line -match '^##\s+(Log|Queue)\b') {
      $cur.End = $i
      $blocks += $cur
      $cur = $null
    }
    elseif ($cur -and $line -match '^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$') {
      $cur.Fields[$Matches[1]] = $Matches[2].Trim()
    }
  }

  if ($cur) { $cur.End = $lines.Count; $blocks += $cur }
  return $blocks
}

function Format-Order($b) {
  $status = $b.Fields['status']
  $priority = $b.Fields['priority']
  $dep = $b.Fields['depends-on']
  $line = "{0}  [{1}]  {2}" -f $b.Id, $status, $b.Title
  if ($priority) { $line += "  ({0})" -f $priority }
  if ($dep) { $line += "  after $dep" }
  return $line
}

function Invoke-OrdersList($a) {
  $blocks = @(Read-Orders)
  $filter = Get-Arg $a 'status'
  $rows = @()
  foreach ($b in $blocks) {
    if ($filter -and $b.Fields['status'] -ne $filter) { continue }
    $rows += Format-Order $b
  }
  if ($rows.Count -eq 0) { return Tool-Text 'No orders match.' }
  $open = @($blocks | Where-Object { $_.Fields['status'] -eq 'open' }).Count
  $text = ("{0} order(s); {1} open.`n`n{2}" -f $blocks.Count, $open, ($rows -join "`n"))
  return Tool-Text $text
}

function Invoke-OrdersAppend($a) {
  $title = Get-Arg $a 'title'
  $do = Get-Arg $a 'do'
  $doneWhen = Get-Arg $a 'doneWhen'
  if (-not $title) { throw 'title is required' }
  if (-not $do) { throw 'do is required' }
  if (-not $doneWhen) { throw 'doneWhen is required' }

  $priority = Get-Arg $a 'priority'; if (-not $priority) { $priority = 'normal' }
  $files = Get-Arg $a 'files'; if (-not $files) { $files = '(unspecified)' }
  $subagents = Get-Arg $a 'subagents'; if (-not $subagents) { $subagents = 'none' }
  $dependsOn = Get-Arg $a 'dependsOn'

  $blocks = @(Read-Orders)
  $max = 0
  foreach ($b in $blocks) {
    $n = [int]($b.Id -replace '\D', '')
    if ($n -gt $max) { $max = $n }
  }
  $id = 'ORD-{0:d3}' -f ($max + 1)
  $dash = [char]0x2014

  $out = @()
  $out += "## $id $dash $title"
  $out += ''
  $out += "priority: $priority"
  $out += 'status: open'
  $out += "files: $files"
  $out += "subagents: $subagents"
  $out += "do: $do"
  $out += "done-when: $doneWhen"
  if ($dependsOn) { $out += "depends-on: $dependsOn" }
  $out += 'result:'
  $out += ''
  $out += '---'
  $out += ''
  $block = ($out -join "`r`n")

  $raw = Get-Content -LiteralPath $ordersPath -Raw -Encoding UTF8
  $idx = $raw.IndexOf('## Log')
  if ($idx -ge 0) {
    $raw = $raw.Substring(0, $idx) + $block + "`r`n" + $raw.Substring($idx)
  }
  else {
    $raw = $raw.TrimEnd() + "`r`n`r`n" + $block
  }
  Set-Content -LiteralPath $ordersPath -Value $raw -Encoding UTF8 -NoNewline
  return Tool-Text "Queued $id ($priority): $title"
}

function Invoke-OrdersReview($a) {
  $id = Get-Arg $a 'id'
  $verdict = Get-Arg $a 'verdict'
  $review = Get-Arg $a 'review'

  if ($id -notmatch '^ORD-\d+$') { throw 'id must look like ORD-001' }
  if ($verdict -notin @('verified', 'rejected')) { throw 'verdict must be verified or rejected' }
  if (-not $review) { throw 'review is required' }

  $lines = @(Get-Content -LiteralPath $ordersPath -Encoding UTF8)
  $blocks = @(Read-Orders)
  $b = $blocks | Where-Object { $_.Id -eq $id } | Select-Object -First 1
  if (-not $b) { throw "No such order: $id" }

  for ($i = $b.Start; $i -lt $b.End; $i++) {
    if ($lines[$i] -match '^status:') { $lines[$i] = "status: $verdict" }
  }

  $sep = -1
  for ($i = $b.Start + 1; $i -lt $b.End; $i++) {
    if ($lines[$i].Trim() -eq '---') { $sep = $i; break }
  }
  $at = if ($sep -ge 0) { $sep } else { $b.End }

  $reviewLine = 'review: ' + ($review -replace "`r?`n", ' ')
  $before = if ($at -gt 0) { @($lines[0..($at - 1)]) } else { @() }
  $after = if ($at -lt $lines.Count) { @($lines[$at..($lines.Count - 1)]) } else { @() }
  $next = @($before) + @($reviewLine, '') + @($after)

  Set-Content -LiteralPath $ordersPath -Value ($next -join "`r`n") -Encoding UTF8 -NoNewline
  return Tool-Text "$id -> $verdict"
}

$tools = @(
  @{
    name        = 'orders_list'
    description = 'List the orders in ORDERS.md with id, status, title, priority and dependency.'
    inputSchema = @{
      type       = 'object'
      properties = @{
        status = @{ type = 'string'; description = 'Only show this status (open, in progress, blocked, done, verified, rejected).' }
      }
      additionalProperties = $false
    }
  },
  @{
    name        = 'orders_append'
    description = 'Append a new, well-formed order to ORDERS.md and return its id.'
    inputSchema = @{
      type       = 'object'
      properties = @{
        title      = @{ type = 'string'; description = 'Short title.' }
        priority   = @{ type = 'string'; enum = @('high', 'normal', 'low') }
        files      = @{ type = 'string'; description = 'Comma-separated file paths.' }
        subagents  = @{ type = 'string'; description = 'OpenChamber subagent instruction, or none.' }
        do         = @{ type = 'string'; description = 'What to change, two or three sentences.' }
        doneWhen   = @{ type = 'string'; description = 'The check that proves it.' }
        dependsOn  = @{ type = 'string'; description = 'Order id this waits on, if any.' }
      }
      required = @('title', 'do', 'doneWhen')
      additionalProperties = $false
    }
  },
  @{
    name        = 'orders_review'
    description = 'Mark an order verified or rejected and append the reviewer evidence.'
    inputSchema = @{
      type       = 'object'
      properties = @{
        id      = @{ type = 'string'; description = 'Order id, e.g. ORD-001.' }
        verdict = @{ type = 'string'; enum = @('verified', 'rejected') }
        review  = @{ type = 'string'; description = 'What was checked and what was found.' }
      }
      required = @('id', 'verdict', 'review')
      additionalProperties = $false
    }
  }
)

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $msg = $null
  try { $msg = $line | ConvertFrom-Json } catch { continue }
  if ($null -eq $msg) { continue }

  $id = $msg.id
  $method = $msg.method

  try {
    switch ($method) {
      'initialize' {
        $pv = '2024-11-05'
        $requested = Get-Arg $msg.params 'protocolVersion'
        if ($requested) { $pv = $requested }
        Reply $id @{
          protocolVersion = $pv
          capabilities    = @{ tools = @{} }
          serverInfo      = @{ name = 'gameday-orders'; version = '1.0.0' }
        }
      }
      'notifications/initialized' { }
      'ping' { Reply $id @{} }
      'tools/list' { Reply $id @{ tools = $tools } }
      'tools/call' {
        $name = Get-Arg $msg.params 'name'
        $args = Get-Arg $msg.params 'arguments'
        $result = $null
        switch ($name) {
          'orders_list'   { $result = Invoke-OrdersList $args }
          'orders_append' { $result = Invoke-OrdersAppend $args }
          'orders_review' { $result = Invoke-OrdersReview $args }
          default         { throw "Unknown tool: $name" }
        }
        Reply $id $result
      }
      default {
        if ($null -ne $id) { Reply-Error $id -32601 "Method not found: $method" }
      }
    }
  }
  catch {
    $message = $_.Exception.Message
    if ($null -ne $id -and $method -eq 'tools/call') {
      Reply $id (Tool-Text $message $true)
    }
    elseif ($null -ne $id) {
      Reply-Error $id -32603 $message
    }
  }
}
