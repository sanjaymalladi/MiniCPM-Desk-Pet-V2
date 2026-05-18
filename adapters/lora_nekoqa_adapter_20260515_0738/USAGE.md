# MiniCPM5-0.9B + NekoQA-30K LoRA Adapter

LoRA adapter trained on liumindmind/NekoQA-30K (30,834 cat-girl QA samples,
12 categories incl. ACG / 心理疗愈 / 创意写作 / 安全 / 数学 / 代码 / 职场).

Trained 2 epochs (3,816 steps) on 1× H100 in 37 min.
LoRA r=16 alpha=32, target modules q/k/v/o/gate/up/down.

## Quick start

```python
import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE = "openbmb/MiniCPM5-0.9B"  # or local path of your 0.9B base
ADAPTER = "./"                   # this dir

tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
base = AutoModelForCausalLM.from_pretrained(
    BASE, trust_remote_code=True, torch_dtype=torch.bfloat16,
    attn_implementation="sdpa", device_map="auto",
)
model = PeftModel.from_pretrained(base, ADAPTER).eval()

SYSTEM = (
    "你是一只可爱的猫娘，名字叫宝宝。请用毛茸茸、撒娇、带「喵」「的说」"
    "「呜哇」等语气词的口吻，配合 (动作) 描述回应主人。"
)
msgs = [
    {"role": "system", "content": SYSTEM},
    {"role": "user",   "content": "我今天好累啊"},
]
text = tok.apply_chat_template(msgs, tokenize=False,
                               add_generation_prompt=True,
                               enable_thinking=False)
ids = tok(text, return_tensors="pt").to(model.device)
out = model.generate(**ids, max_new_tokens=200, do_sample=False,
                     pad_token_id=tok.pad_token_id)
print(tok.decode(out[0, ids.input_ids.shape[1]:], skip_special_tokens=True))
```

## Files

- `adapter_model.safetensors`  LoRA weights (~22 MB)
- `adapter_config.json`        PEFT config
- `README.md`                  PEFT auto-generated README
- `train_meta.json`            training hyperparameters used
- `capability_loss.jsonl`      24-prompt capability regression test results
- `persona_4way.txt`           5-prompt persona comparison (base/muice/mix/neko)
- `REPORT_4WAY.md`             full evaluation report

## Limitations

1. Trained system prompt names the persona "宝宝" (not "沐雪"). If you say
   "雪雪" the model treats it as "snow".
2. Code generation requests are intentionally deflected ("我是猫娘不懂代码喵").
3. Strict format/length instructions (e.g. "5字回答") are weaker than base.

See `REPORT_4WAY.md` for full benchmarking.
