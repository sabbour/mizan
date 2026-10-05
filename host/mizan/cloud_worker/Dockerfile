FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --no-cache-dir \
    "muscriptor @ git+https://github.com/muscriptor/muscriptor.git@7f213afecf23bd6a1b8672aa223690ee9807cefb" \
    azure-identity==1.25.1 azure-storage-blob==12.27.1 \
    numpy==2.2.6 scipy==1.15.3 onnxruntime-gpu==1.20.2
ENV LD_LIBRARY_PATH=/opt/conda/lib/python3.11/site-packages/nvidia/cublas/lib:/opt/conda/lib/python3.11/site-packages/nvidia/cudnn/lib:/opt/conda/lib/python3.11/site-packages/nvidia/cuda_nvrtc/lib:/opt/conda/lib/python3.11/site-packages/nvidia/curand/lib:/opt/conda/lib/python3.11/site-packages/nvidia/cufft/lib:/opt/conda/lib/python3.11/site-packages/nvidia/cuda_runtime/lib:${LD_LIBRARY_PATH}
RUN python -c "import onnxruntime, subprocess; from pathlib import Path; provider=Path(onnxruntime.__file__).parent / 'capi' / 'libonnxruntime_providers_cuda.so'; result=subprocess.run(['ldd', str(provider)], capture_output=True, text=True, check=True); missing=[line.strip() for line in result.stdout.splitlines() if 'not found' in line and not line.strip().startswith('libcuda.so.1 ')]; assert not missing, missing"

WORKDIR /app
COPY worker.py /app/worker.py
RUN useradd --create-home --uid 10001 worker
RUN mkdir /app/work && chown worker:worker /app/work
USER worker
WORKDIR /app/work
ENV HF_HOME=/app/work/huggingface TMPDIR=/app/work PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/app/worker.py"]
