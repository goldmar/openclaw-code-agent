"""Read the task-owned publication archive; never extract or execute members."""
import base64
import gzip
import hashlib
import io
import json
import os
import pathlib
import stat
import sys
import tarfile
import time

MIB = 1048576
MANIFESTS = {'package/package.json', 'package/openclaw.plugin.json', 'package/npm-shrinkwrap.json'}
SAFE_PAX = {'path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'}


def canonical(name):
    assert name and not name.startswith('/') and '\\' not in name and '\x00' not in name
    trimmed = name[:-1] if name.endswith('/') else name
    assert trimmed and all(part not in ['', '.', '..'] for part in trimmed.split('/'))
    return trimmed


def pax_records(data):
    offset, keys = 0, set()
    while offset < len(data):
        space = data.find(b' ', offset)
        assert space > offset and space - offset <= 10
        length = int(data[offset:space])
        assert length > space - offset + 2 and offset + length <= len(data)
        record = data[space + 1:offset + length]
        assert record.endswith(b'\n') and b'=' in record
        key = record.split(b'=', 1)[0].decode('ascii')
        assert key in SAFE_PAX and key not in keys
        keys.add(key)
        offset += length


def physical_headers(data, deadline):
    offset, count = 0, 0
    while offset < len(data):
        assert time.monotonic() <= deadline and offset + 512 <= len(data)
        header = data[offset:offset + 512]
        if header == b'\x00' * 512:
            assert data[offset + 512:offset + 1024] == b'\x00' * 512 and len(data) % 512 == 0
            assert not any(data[offset:]), 'Unexpected bytes after tar terminator'
            return count
        member = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
        count += 1
        assert count <= 4096 and member.size >= 0
        if member.name in ['././@PaxHeader', '././@LongLink']:
            assert member.type in [tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME]
        else:
            canonical(member.name)
        assert member.type in [tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME]
        start, end = offset + 512, offset + 512 + member.size
        assert end <= len(data)
        if member.type in [tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME]:
            assert member.size <= MIB
            if member.type in [tarfile.XHDTYPE, tarfile.XGLTYPE]:
                pax_records(data[start:end])
        offset = start + ((member.size + 511) // 512) * 512
    raise AssertionError('Missing complete tar terminator')


def proof(path):
    deadline = time.monotonic() + 30
    assert pathlib.Path(path).is_absolute()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        assert stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and 0 < before.st_size <= 32 * MIB
        compressed = bytearray()
        while chunk := os.read(fd, 65536):
            compressed.extend(chunk)
            assert len(compressed) <= 32 * MIB and time.monotonic() <= deadline
        after = os.fstat(fd)
        assert (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        assert len(compressed) == before.st_size
    finally:
        os.close(fd)
    data = bytearray()
    with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode='rb') as stream:
        while chunk := stream.read(65536):
            data.extend(chunk)
            assert len(data) <= 64 * MIB and time.monotonic() <= deadline
    physical_count = physical_headers(data, deadline)
    manifests, dist, names = {}, {}, set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for member in archive:
            assert time.monotonic() <= deadline and len(names) < 4096
            name = canonical(member.name)
            assert name == 'package' or name.startswith('package/')
            assert name not in names and not member.sparse and set(member.pax_headers).issubset(SAFE_PAX)
            names.add(name)
            assert member.isdir() or member.isreg()
            if member.isdir():
                assert member.size == 0
                continue
            assert member.size >= 0 and member.size <= (MIB if name in MANIFESTS else 16 * MIB)
            stream = archive.extractfile(member)
            assert stream is not None
            digest, total, content = hashlib.sha256(), 0, bytearray()
            with stream:
                while chunk := stream.read(65536):
                    total += len(chunk); digest.update(chunk)
                    assert total <= member.size and time.monotonic() <= deadline
                    if name in MANIFESTS:
                        content.extend(chunk)
            assert total == member.size
            if name in MANIFESTS:
                manifests[name.removeprefix('package/')] = {'bytes': total, 'sha256': digest.hexdigest(), 'base64': base64.b64encode(content).decode()}
            elif name.startswith('package/dist/'):
                dist[name.removeprefix('package/dist/')] = digest.hexdigest()
    assert set(manifests) == {name.removeprefix('package/') for name in MANIFESTS}
    result = {'tarballSha256': hashlib.sha256(compressed).hexdigest(), 'compressedBytes': len(compressed), 'decompressedBytes': len(data),
              'physicalMembers': physical_count, 'effectiveMembers': len(names), 'manifests': manifests, 'distHashes': dist}
    encoded = json.dumps(result, separators=(',', ':')).encode()
    assert len(encoded) <= 2 * MIB and time.monotonic() <= deadline
    return encoded


if __name__ == '__main__':
    try:
        assert len(sys.argv) == 2
        sys.stdout.buffer.write(proof(sys.argv[1]) + b'\n')
    except Exception as error:
        sys.stderr.write('ARCHIVE_PROOF_REFUSED ' + type(error).__name__ + '\n')
        raise SystemExit(1)
