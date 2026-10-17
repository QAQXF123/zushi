#include <xxh3.h>

#include <cstdlib>
#include <cstring>
#include <error.hpp>
#include <io/file.hpp>
#include <wad/archive.hpp>
#include <numeric>
#include <unordered_map>
#include <chrono>
#include <log.hpp>

using namespace lol;
using namespace lol::wad;

auto Archive::read_from_toc(io::Bytes src, TOC const& toc) -> Archive {
    lol_trace_func(lol_trace_var("{}", toc.entries.size()));
    auto descriptors_by_checksum = std::unordered_map<std::uint64_t, EntryData>{};
    descriptors_by_checksum.reserve(toc.entries.size());
    auto archive = Archive{};
    for (auto const& entry : toc.entries) {
        if (entry.loc.checksum) {
            if (auto old = descriptors_by_checksum.find(entry.loc.checksum); old != descriptors_by_checksum.end()) {
                archive.entries[entry.name] = old->second;
                continue;
            }
        }
        auto data = EntryData::from_loc(src, entry.loc);
        archive.entries[entry.name] = data;
        if (entry.loc.checksum) {
            descriptors_by_checksum[entry.loc.checksum] = data;
        }
    }
    archive.signature = toc.signature;
    return archive;
}

auto Archive::read_from_file(fs::path const& path) -> Archive {
    lol_trace_func(lol_trace_var("{}", path));
    auto src = io::Bytes::from_file(path);
    auto toc = TOC{};
    auto const toc_error = toc.read(src);
    lol_throw_if(toc_error);
    return read_from_toc(src, toc);
}

auto Archive::pack_from_directory(fs::path const& dir) -> Archive {
    lol_trace_func(lol_trace_var("{}", dir));
    auto archive = Archive{};
    for (auto const& dirent : fs::recursive_directory_iterator(dir)) {
        if (!dirent.is_regular_file()) continue;
        archive.add_from_directory(dirent.path(), dir);
    }
    return archive;
}

auto Archive::add_from_directory(fs::path const& path, fs::path const& dir) -> void {
    lol_trace_func(lol_trace_var("{}", path), lol_trace_var("{}", dir));
    auto name = hash::Xxh64::from_path(fs::relative(path, dir));
    auto data = EntryData::from_file(path);
    entries.insert_or_assign(name, data);
}

auto Archive::estimate_size() const noexcept -> std::size_t {
    auto estimate = sizeof(TOC::latest_header_t) + sizeof(TOC::latest_entry_t) * entries.size();
    for (auto const& [name, data] : entries) {
        estimate += data.bytes_size();
    }
    return estimate;
}

// Reuse payload offsets in a private APFS clone. Only changed chunks are appended;
// the old overlay is never opened for writing. No header is committed until the
// complete plan has been checked for table overlap, bounds and compression type.
static auto try_incremental_write(io::File& file, fs::path const& path,
                                  Archive const& archive, TOC::latest_header_t const& header) -> bool {
    using EntryT = TOC::latest_entry_t;
    using HeaderT = TOC::latest_header_t;
    auto toc = TOC{};
    {
        auto bytes = io::Bytes::from_file(path);
        if (toc.read(bytes) || toc.version != TOC::Version::latest() || toc.entries.empty()) return false;
    }
    auto const old_size = file.size();
    auto const estimate = archive.estimate_size();
    // Periodically compact, instead of allowing obsolete chunks to accumulate forever.
    if (old_size > estimate + std::max<std::size_t>(32 * io::MiB, estimate / 4)) return false;
    auto const table_end = sizeof(HeaderT) + archive.entries.size() * sizeof(EntryT);
    auto old_locations = std::unordered_map<std::uint64_t, EntryLoc>{};
    for (auto const& entry : toc.entries) {
        auto const& loc = entry.loc;
        if (loc.offset < table_end || loc.offset > old_size || loc.size > old_size - loc.offset) return false;
        if (loc.checksum) old_locations.emplace(loc.checksum, loc);
    }
    auto table = std::vector<EntryT>{};
    auto writes = std::vector<std::pair<EntryLoc, EntryData>>{};
    auto locations = std::unordered_map<std::uint64_t, EntryLoc>{};
    auto cursor = old_size;
    std::uint64_t reused_bytes = 0, written_bytes = 0;
    for (auto const& [name, original] : archive.entries) {
        auto data = original.into_optimal();
        auto const checksum = data.checksum();
        auto loc = EntryLoc{};
        auto compatible = [&](EntryLoc const& old) {
            return old.type == data.type() && old.size == data.bytes_size() &&
                   old.size_decompressed == data.size_decompressed() &&
                   old.subchunk_count == data.subchunk_count() && old.subchunk_index == data.subchunk_index();
        };
        if (auto i = locations.find(checksum); i != locations.end() && compatible(i->second)) {
            loc = i->second;
        } else if (auto i = old_locations.find(checksum); checksum && i != old_locations.end() && compatible(i->second)) {
            loc = i->second; reused_bytes += loc.size;
        } else {
            if (cursor >= 4 * io::GiB || data.bytes_size() >= 4 * io::GiB - cursor ||
                data.size_decompressed() >= 4 * io::GiB) return false;
            loc = {.type=data.type(), .subchunk_count=data.subchunk_count(), .subchunk_index=data.subchunk_index(),
                   .offset=cursor, .size=data.bytes_size(), .size_decompressed=data.size_decompressed(), .checksum=checksum};
            cursor += loc.size; written_bytes += loc.size;
            writes.emplace_back(loc, std::move(data));
        }
        locations.insert_or_assign(checksum, loc);
        table.push_back(EntryT{.name=name,.offset=(std::uint32_t)loc.offset,.size=(std::uint32_t)loc.size,
            .size_decompressed=(std::uint32_t)loc.size_decompressed,.type=loc.type,.subchunk_count=loc.subchunk_count,
            .subchunk_index=loc.subchunk_index,.checksum=loc.checksum});
    }
    if (reused_bytes < estimate / 2) return false;
    std::sort(table.begin(), table.end(), [](auto const& a, auto const& b){return a.name < b.name;});
    for (auto const& [loc,data] : writes) file.write(loc.offset, data.bytes_data(), loc.size);
    file.write(sizeof(HeaderT), table.data(), table.size() * sizeof(EntryT));
    file.write(0, &header, sizeof(header));
    file.resize(cursor);
    logi("WadWrite: {} mode=incremental reused_bytes={} written_bytes={}", path.filename().generic_string(), reused_bytes,
         written_bytes + sizeof(header) + table.size() * sizeof(EntryT));
    return true;
}

auto Archive::write_to_file(fs::path const& path) const -> void {
    lol_trace_func(lol_trace_var("{}", path));
    auto const started = std::chrono::steady_clock::now();
    using HeaderT = TOC::latest_header_t;
    using EntryT = TOC::latest_entry_t;

    auto file = io::File::create(path);

    auto new_header = HeaderT{
        .version = TOC::Version::latest(),
        .signature = this->signature,
        .checksum = {},
        .desc_count = (std::uint32_t)entries.size(),
    };

    {
        auto version = TOC::Version::latest();
        XXH3_state_s hashstate = {};
        XXH3_64bits_reset(&hashstate);
        XXH3_64bits_update(&hashstate, &version, sizeof(version));
        for (auto const& [name, data] : entries) {
            auto const checksum = data.checksum();
            XXH3_64bits_update(&hashstate, &name, sizeof(name));
            XXH3_64bits_update(&hashstate, &checksum, sizeof(checksum));
        }
        auto const hashdigest = XXH3_64bits_digest(&hashstate);
        static_assert(sizeof(new_header.checksum) == sizeof(hashdigest));
        std::memcpy((char*)&new_header.checksum, (char const*)&hashdigest, sizeof(new_header.checksum));
    }

    if (auto old_header = HeaderT{}; file.readsome(0, &old_header, sizeof(HeaderT)) == sizeof(HeaderT)) {
        if (std::memcmp(&old_header, &new_header, sizeof(HeaderT)) == 0) {
            logi("WadWrite: {} mode=unchanged bytes={}", path.filename().generic_string(), file.size());
            return;
        }
        if (old_header.version == TOC::Version::latest() && try_incremental_write(file, path, *this, new_header)) return;
    }

    auto toc_entries = std::vector<EntryT>{};
    toc_entries.reserve(entries.size());

    std::size_t data_cur = sizeof(HeaderT) + sizeof(EntryT) * entries.size();
    {
        // Order any potential reads by address, this guarantees sequential reads on any memory mapped files.
        auto entries_data = std::vector<std::pair<hash::Xxh64, EntryData>>();
        entries_data.reserve(entries.size());
        entries_data.insert(entries_data.end(), entries.begin(), entries.end());
        std::sort(entries_data.begin(), entries_data.end(), [](auto const& l, auto const& r) -> bool {
            return (std::uintptr_t)l.second.bytes_data() < (std::uintptr_t)r.second.bytes_data();
        });

        // Deduplicate data locations by checksum
        auto loc_by_checksum = std::unordered_map<std::uint64_t, EntryLoc>();
        loc_by_checksum.reserve(entries.size() * 2);

        // Write all entries data and generate TOC
        file.reserve(0, estimate_size());
        for (auto const& entry : entries_data) {
            auto loc = EntryLoc{};
            auto data = entry.second.into_optimal();
            auto checksum = data.checksum();
            if (auto j = loc_by_checksum.find(checksum); j != loc_by_checksum.end()) {
                loc = j->second;
            } else {
                loc = {
                    .type = data.type(),
                    .subchunk_count = data.subchunk_count(),
                    .subchunk_index = data.subchunk_index(),
                    .offset = data_cur,
                    .size = data.bytes_size(),
                    .size_decompressed = data.size_decompressed(),
                    .checksum = checksum,
                };
                lol_throw_if(loc.size >= 4 * io::GiB);
                lol_throw_if(loc.size_decompressed >= 4 * io::GiB);
                lol_throw_if(loc.offset >= 4 * io::GiB);
                file.write(data_cur, data.bytes_data(), data.bytes_size());
                loc_by_checksum.emplace_hint(j, checksum, loc);
                data_cur += loc.size;
            }
            toc_entries.push_back(EntryT{
                .name = entry.first,
                .offset = (std::uint32_t)loc.offset,
                .size = (std::uint32_t)loc.size,
                .size_decompressed = (std::uint32_t)loc.size_decompressed,
                .type = loc.type,
                .subchunk_count = loc.subchunk_count,
                .subchunk_index = loc.subchunk_index,
                .checksum = loc.checksum,
            });
        };
    }

    {
        // TOC entries MUST be sorted by name
        std::sort(toc_entries.begin(), toc_entries.end(), [](auto const& l, auto const& r) -> bool {
            return l.name < r.name;
        });
    }

    // Write TOC after header
    file.write(sizeof(HeaderT), toc_entries.data(), toc_entries.size() * sizeof(EntryT));

    // Write header
    file.write(0, &new_header, sizeof(HeaderT));

    // Trunc data
    file.resize(data_cur);
    logi("WadWrite: {} mode=full written_bytes={} elapsed_ms={}",path.filename().generic_string(),data_cur,
         std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count());
}

auto Archive::touch() -> void {
    // Order any potential reads by address, this guarantees sequential reads on any memory mapped files.
    auto entries = std::vector<std::pair<hash::Xxh64, EntryData>>();
    entries.reserve(entries.size());
    entries.insert(entries.end(), entries.begin(), entries.end());
    std::sort(entries.begin(), entries.end(), [](auto const& l, auto const& r) -> bool {
        return (std::uintptr_t)l.second.bytes_data() < (std::uintptr_t)r.second.bytes_data();
    });

    for (auto& [name, data] : entries) {
        data.touch();
    }
}

auto Archive::mark_optimal() -> void {
    for (auto& [name, data] : entries) {
        data.mark_optimal(true);
    }
}
