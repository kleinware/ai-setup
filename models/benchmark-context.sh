#!/usr/bin/env bash

set -uo pipefail

readonly PROMPT='what is the union type in Typescript?'
readonly IMAGE_PROMPT='describe the image'
readonly TEST_IMAGE='test_image.png'
readonly TOKENS=128
readonly REPEATS=3
readonly -a CONTEXT_SIZES=(1024 32768 65536 131072 262144)

LLAMA_CLI=${LLAMA_CLI:-llama-cli}

usage() {
    cat >&2 <<EOF
Usage: $(basename "$0") MODEL.gguf [MODEL.gguf ...]

Benchmarks each model three times at 1K, 32K, 64K, 128K, and 256K context.
When a matching PREFIX-mmproj-TYPE.gguf exists beside a model, also runs an
image benchmark using $TEST_IMAGE and adds a "MODEL mmproj TYPE" row.
Set LLAMA_CLI to use a llama-cli binary that is not on PATH, for example:

  LLAMA_CLI=/path/to/llama-cli $(basename "$0") model.gguf

The Markdown table is written to stdout; progress and errors go to stderr.
EOF
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

median_of_three() {
    printf '%s\n' "$@" |
        LC_ALL=C sort -g |
        sed -n '2p' |
        LC_ALL=C awk '{ printf "%d\n", int($1 + 0.5) }'
}

extract_last_speed() {
    local label=$1
    local output=$2
    local speeds

    # The stats line always lists Prompt first and Generation second. Extracting
    # its numeric t/s fields avoids terminal control bytes embedded in labels.
    speeds=$(
        printf '%s\n' "$output" |
            grep -a 't/s' |
            tail -n 1 |
            grep -aoE '[0-9]+([.][0-9]+)?[[:space:]]+t/s' |
            sed -E 's/[[:space:]]+t\/s//'
    )

    if [[ $label == Prompt ]]; then
        printf '%s\n' "$speeds" | head -n 1
    else
        printf '%s\n' "$speeds" | tail -n 1
    fi
}

extract_context_length() {
    local output=$1

    # Typical metadata line: llama.context_length u32 = 131072
    printf '%s\n' "$output" |
        sed $'s/\033\\[[0-9;?]*[[:alpha:]]//g' |
        sed -nE 's/.*\.context_length[[:space:]]+u32[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' |
        head -n 1
}

[[ $# -gt 0 ]] || { usage; exit 2; }
command -v "$LLAMA_CLI" >/dev/null 2>&1 || die "llama-cli not found: $LLAMA_CLI"
command -v setsid >/dev/null 2>&1 || die "setsid is required to capture llama-cli output reliably"

for model in "$@"; do
    [[ -f "$model" ]] || die "model file not found: $model"
    [[ ${model##*/} != *-mmproj-*.gguf ]] || die "pass model files, not mmproj files: $model"
done

declare -a rows=()

benchmark_variant() {
    local model=$1
    local prompt=$2
    local model_name=$3
    local mmproj=${4:-}
    local model_context_length=''
    local context_size run output status prompt_speed generation_speed detected_context_length
    local -a vision_args=()
    local -a prompt_medians=()
    local -a generation_medians=()

    if [[ -n $mmproj ]]; then
        vision_args=(--mmproj "$mmproj" --image "$TEST_IMAGE")
    fi

    for context_size in "${CONTEXT_SIZES[@]}"; do
        local -a prompt_speeds=()
        local -a generation_speeds=()
        local context_unsupported=0

        for ((run = 1; run <= REPEATS; run++)); do
            printf 'Benchmarking %s: context=%s, run=%d/%d\n' \
                "$model_name" "$context_size" "$run" "$REPEATS" >&2

            output=$(
                setsid --wait "$LLAMA_CLI" \
                    -fa on \
                    -ctk q8_0 \
                    -ctv q8_0 \
                    -c "$context_size" \
                    -p "$prompt" \
                    -n "$TOKENS" \
                    -st \
                    -v \
                    -m "$model" \
                    "${vision_args[@]}" </dev/null 2>&1
            )
            status=$?
            if ((status != 0)); then
                printf '%s\n' "$output" >&2
                die "llama-cli failed for $model at context $context_size (run $run, exit $status)"
            fi

            if printf '%s\n' "$output" | grep -aq 'exceeds the available context size'; then
                detected_context_length=$(extract_context_length "$output")
                [[ -n "$detected_context_length" ]] || die "could not find .context_length metadata for $model at context $context_size (run $run)"
                if [[ -n "$model_context_length" && "$model_context_length" != "$detected_context_length" ]]; then
                    die "model context length changed from $model_context_length to $detected_context_length for $model"
                fi
                model_context_length=$detected_context_length
                printf 'Skipping remaining runs for %s at context=%s: input does not fit\n' \
                    "$model_name" "$context_size" >&2
                context_unsupported=1
                break
            fi

            prompt_speed=$(extract_last_speed 'Prompt' "$output")
            generation_speed=$(extract_last_speed 'Generation' "$output")
            detected_context_length=$(extract_context_length "$output")

            [[ -n "$prompt_speed" ]] || die "could not find Prompt speed for $model at context $context_size (run $run)"
            [[ -n "$generation_speed" ]] || die "could not find Generation speed for $model at context $context_size (run $run)"
            [[ -n "$detected_context_length" ]] || die "could not find .context_length metadata for $model at context $context_size (run $run)"

            if [[ -n "$model_context_length" && "$model_context_length" != "$detected_context_length" ]]; then
                die "model context length changed from $model_context_length to $detected_context_length for $model"
            fi
            model_context_length=$detected_context_length
            prompt_speeds+=("$prompt_speed")
            generation_speeds+=("$generation_speed")
        done

        if ((context_unsupported)); then
            prompt_medians+=(-)
            generation_medians+=(-)
            continue
        fi

        prompt_medians+=("$(median_of_three "${prompt_speeds[@]}")")
        generation_medians+=("$(median_of_three "${generation_speeds[@]}")")
    done

    rows+=("|${model_name}|${model_context_length}|${prompt_medians[0]}|${prompt_medians[1]}|${prompt_medians[2]}|${prompt_medians[3]}|${prompt_medians[4]}|${generation_medians[0]}|${generation_medians[1]}|${generation_medians[2]}|${generation_medians[3]}|${generation_medians[4]}|")
}

for model in "$@"; do
    model_dir=$(dirname -- "$model")
    model_file=${model##*/}
    model_name=${model_file%.gguf}

    benchmark_variant "$model" "$PROMPT" "$model_name"

    shopt -s nullglob
    mmproj_candidates=("$model_dir"/*-mmproj-*.gguf)
    shopt -u nullglob

    for mmproj in "${mmproj_candidates[@]}"; do
        mmproj_file=${mmproj##*/}
        model_prefix=${mmproj_file%%-mmproj-*}

        [[ $model_file == "$model_prefix"-*.gguf ]] || continue

        [[ -f $TEST_IMAGE ]] || die "matching mmproj found for $model, but image file is missing: $TEST_IMAGE"
        mmproj_type=${mmproj_file#"$model_prefix-mmproj-"}
        mmproj_type=${mmproj_type%.gguf}
        benchmark_variant "$model" "$IMAGE_PROMPT" "$model_name mmproj $mmproj_type" "$mmproj"
    done
done

printf '%s\n' '|Model Name|Max context|1K PP|32K PP|64K PP|128K PP|256K PP|1K Gen|32K Gen|64K Gen|128K Gen|256K Gen|'
printf '%s\n' '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
printf '%s\n' "${rows[@]}"
