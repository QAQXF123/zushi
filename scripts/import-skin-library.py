#!/usr/bin/env python3
"""Import the complete repository archive into Zushi's existing skin layout."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import zipfile


def component(value):
    value = value.replace('/', '%2F')
    if value in ('', '.', '..') or '\x00' in value:
        raise ValueError('Invalid skin name')
    return value


def import_library(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        ids_member = next(m for m in members if m.isfile() and m.name.endswith('/resources/en/skin_ids.json'))
        skin_ids = json.load(source.extractfile(ids_member))
        entries = sorted((m for m in members if m.isfile() and '/skins/' in m.name and m.name.endswith(('.fantome', '.zip'))), key=lambda m: m.name)
        repo_files = []
        used = {}
        imported = skipped = 0
        for entry in entries:
            repo_path = 'skins/' + entry.name.split('/skins/', 1)[1]
            skin_id = Path(entry.name).stem
            if not skin_id.isdigit():
                raise ValueError(f'Invalid skin ID: {skin_id}')
            champion = skin_ids.get(str(int(skin_id) // 1000 * 1000), f'Champion {int(skin_id) // 1000}')
            data = source.extractfile(entry).read()
            with zipfile.ZipFile(io.BytesIO(data)) as skin_zip:
                bad = skin_zip.testzip()
                if bad:
                    raise ValueError(f'Corrupt skin {skin_id}: {bad}')
                name = skin_ids.get(skin_id)
                if not name:
                    info = json.loads(skin_zip.read('META/info.json'))
                    name = info.get('Name') or f'Skin {skin_id}'
            logical = (champion, name)
            if logical in used and used[logical] != skin_id:
                name = f'{name} [{skin_id}]'
            used[(champion, name)] = skin_id
            skin_ids[skin_id] = name
            target = destination / component(champion) / component(name) / (component(name) + '.zip')
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256(data).hexdigest()
            if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
                skipped += 1
            else:
                temporary = target.with_suffix('.zip.part')
                temporary.write_bytes(data)
                os.replace(temporary, target)
                imported += 1
            repo_files.append([skin_id, repo_path])
        metadata = {'format': 'zushi-skins-v1', 'count': len(entries), 'skinIds': skin_ids, 'repoFiles': repo_files}
        temporary = destination / '.zushi-library.json.part'
        temporary.write_text(json.dumps(metadata, ensure_ascii=False))
        os.replace(temporary, destination / '.zushi-library.json')
        count = sum(1 for _ in destination.glob('*/*/*.zip'))
        if count < len(entries):
            raise RuntimeError(f'Expected {len(entries)} skins, found {count}')
        print(f'Imported {imported}, already present {skipped}; total {count} skins in {destination}')
        return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    import_library(args.archive, args.destination)
