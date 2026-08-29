export type DoctorCheckStatus = "ok" | "attention" | "error";
export type DoctorStatus = "ready" | "degraded" | "error";

export type DoctorCheckId = "node" | "data_directory" | "moondream" | "camsnap" | "ffmpeg" | "camera";

export interface DoctorCheck {
  id: DoctorCheckId;
  label: string;
  status: DoctorCheckStatus;
  message: string;
  details?: Readonly<Record<string, string | number | boolean>>;
}

export interface DoctorReport {
  status: DoctorStatus;
  checkedAt: string;
  checks: readonly DoctorCheck[];
}

export function doctorStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "attention")) return "degraded";
  return "ready";
}
