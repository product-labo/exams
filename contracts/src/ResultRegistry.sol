// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// The student pays `fee` of `token` to the treasury and, in the same transaction,
/// records the hash of their exam result on-chain. Only hashes are stored, no personal data.
contract ResultRegistry {
    address public immutable owner;
    IERC20 public immutable token;
    address public treasury;
    uint256 public fee;

    mapping(bytes32 => uint256) public anchoredAt;
    mapping(bytes32 => address) public payerOf;

    event Anchored(bytes32 indexed resultHash, address indexed payer, uint256 timestamp);

    constructor(address _token, address _treasury, uint256 _fee) {
        require(_token != address(0) && _treasury != address(0), "zero address");
        owner = msg.sender;
        token = IERC20(_token);
        treasury = _treasury;
        fee = _fee;
    }

    function payAndAnchor(bytes32 resultHash) external {
        require(anchoredAt[resultHash] == 0, "already anchored");
        anchoredAt[resultHash] = block.timestamp;
        payerOf[resultHash] = msg.sender;
        require(token.transferFrom(msg.sender, treasury, fee), "payment failed");
        emit Anchored(resultHash, msg.sender, block.timestamp);
    }

    function setFee(uint256 _fee) external { require(msg.sender == owner, "not owner"); fee = _fee; }
    function setTreasury(address _t) external { require(msg.sender == owner, "not owner"); require(_t != address(0), "zero address"); treasury = _t; }
}
