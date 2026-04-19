#!/usr/bin/env python3
"""Benchmark Discogs Effnet variants against the same audio files."""

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ANALYZER_PATH = Path(__file__).with_name("analyzer.py")
DEFAULT_VARIANTS = ("bs64",)
KNOWN_INCOMPATIBLE_VARIANTS = {
    "bs1": "current essentia-tensorflow TensorflowPredictEffnetDiscogs runtime fails with a reshape error",
}
COMPARE_FIELDS = (
    "bpm",
    "energy",
    "danceability",
    "danceabilityMl",
    "valence",
    "arousal",
    "instrumentalness",
    "acousticness",
    "speechiness",
    "moodHappy",
    "moodSad",
    "moodRelaxed",
    "moodAggressive",
    "moodParty",
    "moodAcoustic",
    "moodElectronic",
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Benchmark Discogs Effnet base model variants on the same tracks."
    )
    parser.add_argument("audio_files", nargs="+", help="Audio files to analyze")
    parser.add_argument(
        "--variants",
        nargs="+",
        default=list(DEFAULT_VARIANTS),
        help="Effnet variants to test (default: bs64 bs1)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the full benchmark report as JSON",
    )
    return parser.parse_args()


def read_peak_rss_kb(pid: int) -> int:
    status_path = Path(f"/proc/{pid}/status")
    peak_rss_kb = 0
    while status_path.exists():
        try:
            for line in status_path.read_text().splitlines():
                if line.startswith("VmHWM:") or line.startswith("VmRSS:"):
                    parts = line.split()
                    if len(parts) >= 2:
                        peak_rss_kb = max(peak_rss_kb, int(parts[1]))
        except (FileNotFoundError, ProcessLookupError):
            break
        time.sleep(0.05)
    return peak_rss_kb


def run_single_benchmark(audio_file: str, variant: str):
    env = os.environ.copy()
    env["EFFNET_MODEL_VARIANT"] = variant
    command = [sys.executable, str(ANALYZER_PATH), "--test", audio_file]

    start = time.perf_counter()
    with tempfile.TemporaryFile(mode="w+") as stderr_file:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            text=True,
            env=env,
        )
        peak_rss_kb = read_peak_rss_kb(process.pid)
        stdout, _ = process.communicate()
        stderr_file.seek(0)
        stderr = stderr_file.read()
    elapsed_seconds = time.perf_counter() - start

    if process.returncode != 0:
        raise RuntimeError(
            f"Variant {variant} failed for {audio_file}\n"
            f"stdout:\n{stdout}\n"
            f"stderr:\n{stderr}"
        )

    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Variant {variant} produced invalid JSON for {audio_file}\n"
            f"stdout:\n{stdout}\n"
            f"stderr:\n{stderr}"
        ) from exc

    return {
        "audio_file": audio_file,
        "variant": variant,
        "elapsed_seconds": round(elapsed_seconds, 3),
        "peak_rss_mb": round(peak_rss_kb / 1024, 1),
        "analysis_mode": result.get("analysisMode"),
        "result": result,
        "stderr": stderr.strip(),
    }


def summarize_variant(runs):
    elapsed_values = [run["elapsed_seconds"] for run in runs]
    rss_values = [run["peak_rss_mb"] for run in runs]
    return {
        "tracks": len(runs),
        "elapsed_mean_seconds": round(statistics.mean(elapsed_values), 3),
        "elapsed_median_seconds": round(statistics.median(elapsed_values), 3),
        "elapsed_max_seconds": round(max(elapsed_values), 3),
        "peak_rss_mean_mb": round(statistics.mean(rss_values), 1),
        "peak_rss_max_mb": round(max(rss_values), 1),
        "analysis_modes": sorted({run["analysis_mode"] for run in runs}),
    }


def compare_variants(report, variants):
    if len(variants) < 2:
        return {}

    baseline = variants[0]
    comparisons = {}
    for candidate in variants[1:]:
        deltas = {field: [] for field in COMPARE_FIELDS}
        for audio_file in report[baseline]["tracks"]:
            base_result = report[baseline]["tracks"][audio_file]["result"]
            candidate_result = report[candidate]["tracks"][audio_file]["result"]
            for field in COMPARE_FIELDS:
                base_value = base_result.get(field)
                candidate_value = candidate_result.get(field)
                if isinstance(base_value, (int, float)) and isinstance(
                    candidate_value, (int, float)
                ):
                    deltas[field].append(abs(candidate_value - base_value))

        field_summary = {}
        for field, values in deltas.items():
            if values:
                field_summary[field] = {
                    "avg_abs_delta": round(statistics.mean(values), 4),
                    "max_abs_delta": round(max(values), 4),
                }

        comparisons[f"{candidate}_vs_{baseline}"] = field_summary

    return comparisons


def print_human_report(report, variants):
    print("Effnet variant benchmark")
    print()
    for variant in variants:
        summary = report[variant]["summary"]
        print(
            f"{variant}: tracks={summary['tracks']}, "
            f"mean={summary['elapsed_mean_seconds']}s, "
            f"median={summary['elapsed_median_seconds']}s, "
            f"max={summary['elapsed_max_seconds']}s, "
            f"peak_rss_mean={summary['peak_rss_mean_mb']}MB, "
            f"peak_rss_max={summary['peak_rss_max_mb']}MB, "
            f"modes={','.join(summary['analysis_modes'])}"
        )

    if len(variants) > 1:
        print()
        print("Prediction deltas")
        comparisons = compare_variants(report, variants)
        for label, fields in comparisons.items():
            print(label)
            ranked_fields = sorted(
                fields.items(), key=lambda item: item[1]["avg_abs_delta"], reverse=True
            )
            for field, delta in ranked_fields[:8]:
                print(
                    f"  {field}: avg_abs_delta={delta['avg_abs_delta']}, max_abs_delta={delta['max_abs_delta']}"
                )


def main():
    args = parse_args()
    audio_files = [str(Path(path).resolve()) for path in args.audio_files]
    variants = [variant.strip().lower() for variant in args.variants]

    incompatible = {
        variant: KNOWN_INCOMPATIBLE_VARIANTS[variant]
        for variant in variants
        if variant in KNOWN_INCOMPATIBLE_VARIANTS
    }
    if incompatible:
        details = "; ".join(
            f"{variant}: {reason}" for variant, reason in incompatible.items()
        )
        raise SystemExit(f"Requested incompatible variants: {details}")

    report = {}
    for variant in variants:
        runs = []
        tracks = {}
        for audio_file in audio_files:
            run = run_single_benchmark(audio_file, variant)
            runs.append(run)
            tracks[audio_file] = run
        report[variant] = {
            "summary": summarize_variant(runs),
            "tracks": tracks,
        }

    if args.json:
        print(json.dumps({"variants": variants, "report": report}, indent=2))
        return

    print_human_report(report, variants)


if __name__ == "__main__":
    main()
