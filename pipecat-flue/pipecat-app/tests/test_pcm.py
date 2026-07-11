"""No-network unit test: WAV wrapping is byte-correct."""
import struct

from bot.mai_stt import pcm_to_wav


def test_pcm_to_wav_header():
    pcm = b"\x01\x00" * 8000  # 8000 samples, 16-bit
    wav = pcm_to_wav(pcm, sample_rate=16000)
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    assert wav[12:16] == b"fmt "
    # data chunk size == len(pcm)
    data_size = struct.unpack("<I", wav[40:44])[0]
    assert data_size == len(pcm)
    # sample rate field
    assert struct.unpack("<I", wav[24:28])[0] == 16000
    # total file = 44-byte header + data
    assert len(wav) == 44 + len(pcm)
