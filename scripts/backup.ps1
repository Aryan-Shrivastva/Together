param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\backups'),
  [string]$ComposeFile = 'docker-compose.production.yml',
  [string]$EnvironmentFile = '.env.production'
)

$ErrorActionPreference = 'Stop'
$resolvedOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Save-DockerStream {
  param(
    [string[]]$Arguments,
    [string]$Path
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = 'docker'
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) {
    $startInfo.ArgumentList.Add($argument)
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    if (-not $process.Start()) {
      throw "Unable to start Docker for backup: $Path"
    }
    $process.StandardOutput.BaseStream.CopyTo($stream)
    $errorOutput = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "Docker backup failed: $errorOutput"
    }
  } finally {
    $stream.Dispose()
    $process.Dispose()
  }
}

$composeArguments = @('compose', '--env-file', $EnvironmentFile, '-f', $ComposeFile)
Save-DockerStream ($composeArguments + @('exec', '-T', 'postgres', 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc')) (Join-Path $resolvedOutputDirectory "database-$stamp.dump")
Save-DockerStream ($composeArguments + @('exec', '-T', 'server', 'tar', '-czf', '-', '-C', '/data', 'workspaces')) (Join-Path $resolvedOutputDirectory "workspaces-$stamp.tar.gz")
Write-Output "Backups written to $resolvedOutputDirectory"
