import { cpus, release, totalmem } from "node:os";

/** The machine a run measured on, as the run file's environment shows it. */
export interface RigInfo {
  machine: string;
  chip: string;
  cores: string;
  memory: string;
  os: string;
  arch: string;
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

async function windows(): Promise<RigInfo> {
  const script = `
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$mem = Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum
$speed = (Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1).ConfiguredClockSpeed
$ver = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion
[pscustomobject]@{
  machine = ($cs.Manufacturer + ' ' + $cs.Model).Trim()
  chip = $cpu.Name.Trim()
  cores = "$($cpu.NumberOfCores) cores / $($cpu.NumberOfLogicalProcessors) threads"
  memory = "$([math]::Round($mem.Sum / 1GB)) GB" + $(if ($speed) { " at $speed MT/s" } else { '' })
  os = "$($os.Caption) $ver (build $($os.BuildNumber))"
  arch = $os.OSArchitecture
} | ConvertTo-Json -Compress`;
  const r = JSON.parse(await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script])) as RigInfo;
  return { ...r, arch: r.arch.replace("64-bit", "x64") };
}

async function darwin(): Promise<RigInfo> {
  const cores = await run(["sysctl", "-n", "hw.ncpu"]);
  const perf = await run(["sysctl", "-n", "hw.perflevel0.logicalcpu"]).catch(() => "");
  const eff = await run(["sysctl", "-n", "hw.perflevel1.logicalcpu"]).catch(() => "");
  return {
    machine: await run(["sysctl", "-n", "hw.model"]),
    chip: await run(["sysctl", "-n", "machdep.cpu.brand_string"]),
    cores: perf && eff ? `${cores} CPU cores (${perf} performance, ${eff} efficiency)` : `${cores} CPU cores`,
    memory: `${Math.round(totalmem() / 1024 ** 3)} GB`,
    os: `macOS ${await run(["sw_vers", "-productVersion"])}`,
    arch: await run(["uname", "-m"]),
  };
}

export async function rigInfo(): Promise<RigInfo> {
  if (process.platform === "win32") return windows();
  if (process.platform === "darwin") return darwin();
  return {
    machine: "unknown",
    chip: cpus()[0]?.model.trim() ?? "unknown",
    cores: `${cpus().length} threads`,
    memory: `${Math.round(totalmem() / 1024 ** 3)} GB`,
    os: `${process.platform} ${release()}`,
    arch: process.arch,
  };
}
