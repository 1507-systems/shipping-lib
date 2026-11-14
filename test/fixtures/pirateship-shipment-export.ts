/**
 * Fixture shaped like a Pirate Ship Shipments-grid CSV export
 * (Ship > search with a blank field > Export; article 4143612).
 *
 * Pirate Ship documents these column names: State, Country, Order ID,
 * Carrier, Insurance Type, Service (article 4143612) and Address 1, Address 2,
 * City, ZIP (EZFormz export guide), plus tracking number / status / date /
 * tracking URL fields. The exact spellings of the undocumented ones
 * ("Tracking Number", "Created Date", "Recipient", "Cost", "Tracking Status",
 * "Tracking URL") are ASSUMED; the importer matches them through aliases.
 * "Rubber Stamp 1" and "Requested Shipping Service" are the passthrough
 * columns our upload adds.
 *
 * Records (record 1 is the header):
 *  2  ORDER-1001        UPS Ground, matches checkout
 *  3  ORDER-1002/1of2   UPS 2nd Day Air, parcel 1
 *  4  ORDER-1002/2of2   UPS 2nd Day Air, parcel 2
 *  5  ORDER-1003        bought USPS Ground Advantage, checkout was UPS Ground (mismatch)
 *  6  (no Order ID)     Dana Lee 80501, USPS Priority Mail Cubic (recipient fallback -> ORDER-1004)
 *  7  ORDER-1006        refunded label
 *  8  ORDER-1007        no tracking number yet
 */
export const PIRATE_SHIP_EXPORT_CSV = [
  '﻿"Created Date","Recipient","Company","Email","Address 1","Address 2","City","State","Zip","Country","Carrier","Service","Package Type","Weight (oz)","Tracking Number","Tracking Status","Tracking URL","Cost","Insurance Type","Insured Value","Order ID","Rubber Stamp 1","Requested Shipping Service"',
  '"11/12/2026","Ada Lovelace","","ada@example.com","12 Analytical Way","","Longmont","CO","80501","US","UPS","UPS® Ground","Package","40","1Z999AA10123456784","In Transit","https://www.ups.com/track?tracknum=1Z999AA10123456784","$12.34","None","","ORDER-1001","ORDER-1001","UPS® Ground"',
  '"11/12/2026","Grace Hopper","Navy, Inc.","","1 Compiler Ct","Apt 2","Arlington","VA","22201-1234","US","UPS","UPS 2nd Day Air®","Package","20","1Z999AA10123456791","Label Created","https://www.ups.com/track?tracknum=1Z999AA10123456791","$25.10","Carrier","100.00","ORDER-1002/1of2","ORDER-1002/1of2","UPS 2nd Day Air®"',
  '"11/12/2026","Grace Hopper","Navy, Inc.","","1 Compiler Ct","Apt 2","Arlington","VA","22201-1234","US","UPS","UPS 2nd Day Air®","Package","18.5","1Z999AA10123456808","Label Created","https://www.ups.com/track?tracknum=1Z999AA10123456808","$24.05","Carrier","100.00","ORDER-1002/2of2","ORDER-1002/2of2","UPS 2nd Day Air®"',
  '"11/13/2026","Alan Turing","","","7 Enigma Rd","","Boulder","CO","80302","US","USPS","USPS Ground Advantage™","Package","12","9400100000000000000017","Pre-Transit","https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000017","$6.02","None","","ORDER-1003","ORDER-1003","UPS® Ground"',
  '"11/13/2026","Dana Lee","","","5 Main St","","Longmont","CO","80501-4455","US","USPS","USPS Priority Mail® Cubic","Package","8","9405500000000000000024","Delivered","https://tools.usps.com/go/TrackConfirmAction?tLabels=9405500000000000000024","$7.15","None","","","",""',
  '"11/13/2026","Edsger Dijkstra","","","3 Shortest Path","","Austin","TX","78701","US","UPS","UPS® Ground","Package","16","1Z999AA10123456815","Refunded","","$9.99","None","","ORDER-1006","ORDER-1006","UPS® Ground"',
  '"11/13/2026","Barbara Liskov","","","9 Substitution Ave","","Cambridge","MA","02139","US","USPS","USPS Priority Mail®","Package","10","","","","","None","","ORDER-1007","ORDER-1007","USPS Priority Mail®"',
  '',
].join('\r\n');
